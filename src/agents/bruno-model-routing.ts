/**
 * DEV-only bridge that asks Bruno Model Routing to decide the model for an
 * ordinary agent/WhatsApp conversational turn *before* OpenClaw executes a
 * provider. OpenClaw owns only the narrow port below; Bruno Brain owns the
 * classification, candidate tiers, policy, and the actual routing engine.
 *
 * The bridge is side-effect free apart from bounded telemetry. It never logs
 * prompt content, credentials, keys, or user data.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { claimBrunoHighBrainOverrideForRouting } from "./bruno-high-brain.js";
import {
  resolveTrustedBrunoRoutingCapability,
  type TrustedBrunoRoutingCapability,
} from "./bruno-routing-capability.js";

const log = createSubsystemLogger("bruno-model-routing");

export type BrunoModelRoutingFacts = {
  /** Bounded semantic prompt text used only for complexity classification. */
  promptText: string;
  /** Prompt size metadata only. Never used to classify complexity. */
  bodyLength: number;
  isGroup: boolean;
  senderIsOwner: boolean;
  commandAuthorized: boolean;
};

export type BrunoModelRoutingClassification = {
  taskType: "reasoning" | "classification" | "summarization" | "extraction";
  complexity: "low" | "medium" | "high";
  riskLevel: "low" | "medium" | "high" | "critical";
  factors?: string[];
  rationale?: string;
};

export type BrunoModelRouterSelection = {
  provider: string;
  model: string;
};

/** Normalized decision returned by the injected router. */
export type BrunoModelRouterDecision = {
  reason: "selected" | "fallback_selected" | "no_acceptable_model";
  selectedModel: BrunoModelRouterSelection | null;
  /** Ordered, Bruno-approved fallback candidates. OpenClaw must not add others. */
  fallbackAlternatives?: BrunoModelRouterSelection[];
  policyVersion?: string;
  /** Authoritative classification used for this decision. */
  classification?: BrunoModelRoutingClassification;
};

/**
 * The seam OpenClaw depends on. Bruno Brain's authoritative entrypoint is
 * adapted to this port at wiring time; OpenClaw never imports Bruno Brain
 * directly, so the package graphs stay acyclic.
 */
export interface BrunoModelRouter {
  route(
    facts: BrunoModelRoutingFacts,
    context: {
      capabilityId: string;
      traceId?: string;
      correlationId?: string;
      /** Host-authorized one-shot HIGH classification override. */
      forcedTier?: "high";
    },
  ): BrunoModelRouterDecision | Promise<BrunoModelRouterDecision>;
}

export type BrunoModelRoutingTurnResult =
  | { kind: "not-applicable" }
  | {
      kind: "selected";
      provider: string;
      model: string;
      reason: "selected" | "fallback_selected";
      policyVersion?: string;
      /** Ordered, Bruno-approved fallback candidates for this routing decision. */
      fallbackAlternatives: BrunoModelRouterSelection[];
      classification?: BrunoModelRoutingClassification;
      capabilityId: TrustedBrunoRoutingCapability;
      traceId?: string;
      correlationId?: string;
    }
  | {
      kind: "fail-closed";
      reason: "router-unavailable" | "router-error" | "no-acceptable-model";
      message: string;
      classification?: BrunoModelRoutingClassification;
      capabilityId?: TrustedBrunoRoutingCapability;
      traceId?: string;
      correlationId?: string;
    };

export const BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT =
  "Model routing is unavailable right now and no governed fallback was selected, so this message was not answered automatically.";

export const BRUNO_MODEL_ROUTING_ENV_KEY = "OPENCLAW_BRUNO_MODEL_ROUTING";

let currentRouter: BrunoModelRouter | null = null;

/** Test/wiring hook. Production wiring injects the Bruno Brain adapter here. */
export function setBrunoModelRouter(router: BrunoModelRouter | null): void {
  currentRouter = router;
}

export function getBrunoModelRouter(): BrunoModelRouter | null {
  return currentRouter;
}

/** DEV-only gate. Off by default so non-Bruno behavior is fully preserved. */
export function isBrunoModelRoutingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[BRUNO_MODEL_ROUTING_ENV_KEY];
  return raw === "1" || raw === "true" || raw === "on";
}

function boundedRef(value: string | undefined, max = 160): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
}

function emitDecisionTelemetry(params: {
  capabilityId: string;
  complexity?: string;
  riskLevel?: string;
  policyVersion?: string;
  reason: string;
  selectedProvider?: string;
  selectedModel?: string;
  requestedProvider?: string;
  requestedModel?: string;
  fallbackCount?: number;
  fallbackCandidates?: string[];
  sessionKey?: string;
  traceId?: string;
  correlationId?: string;
}): void {
  log.info("bruno_model_routing_decision", {
    sessionKey: boundedRef(params.sessionKey),
    traceId: boundedRef(params.traceId),
    correlationId: boundedRef(params.correlationId),
    capabilityId: boundedRef(params.capabilityId),
    complexity: params.complexity,
    riskLevel: params.riskLevel,
    policyVersion: boundedRef(params.policyVersion),
    reason: params.reason,
    requestedProvider: boundedRef(params.requestedProvider),
    requestedModel: boundedRef(params.requestedModel),
    selectedProvider: boundedRef(params.selectedProvider),
    selectedModel: boundedRef(params.selectedModel),
    fallbackCount: params.fallbackCount,
    fallbackCandidates: params.fallbackCandidates,
  });
}

export async function routeConversationalTurnWithBruno(params: {
  enabled: boolean;
  scope: {
    messageProvider?: string | null;
    chatType?: string | null;
    outboundGroupReplyAuthorization?:
      | import("../plugins/hook-message.types.js").PluginHookOutboundGroupReplyAuthorization
      | null;
  };
  facts: BrunoModelRoutingFacts;
  sessionKey?: string;
  traceId?: string;
  correlationId?: string;
  requestedProvider?: string;
  requestedModel?: string;
  /** Host-derived one-shot High Brain override pointer (opaque source event id). */
  highBrainSourceEventId?: string;
}): Promise<BrunoModelRoutingTurnResult> {
  if (!params.enabled) {
    return { kind: "not-applicable" };
  }

  const capabilityId = resolveTrustedBrunoRoutingCapability({
    messageProvider: params.scope.messageProvider,
    chatType: params.scope.chatType,
    outboundGroupReplyAuthorization: params.scope.outboundGroupReplyAuthorization,
  });
  if (!capabilityId) {
    return { kind: "not-applicable" };
  }

  const traceId = boundedRef(params.traceId);
  const correlationId = boundedRef(params.correlationId) ?? boundedRef(params.sessionKey);

  // The one-shot HIGH decision is host-derived. The opaque source event id
  // points at the authoritative core override registry; a missing, consumed,
  // or expired override fails closed rather than falling back to semantic
  // classification (which would downgrade the authorized HIGH request).
  let forcedTier: "high" | undefined;
  if (params.highBrainSourceEventId) {
    const claim = claimBrunoHighBrainOverrideForRouting(params.highBrainSourceEventId);
    if (claim.status !== "authorized") {
      log.warn("bruno_high_brain_routing_denied", {
        reason: claim.status === "denied" ? claim.reason : "unavailable",
      });
      emitDecisionTelemetry({
        capabilityId,
        reason: "high-brain-override-denied",
        requestedProvider: params.requestedProvider,
        requestedModel: params.requestedModel,
        sessionKey: params.sessionKey,
        traceId,
        correlationId,
      });
      return {
        kind: "fail-closed",
        reason: "no-acceptable-model",
        message: BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
        capabilityId,
        traceId,
        correlationId,
      };
    }
    forcedTier = "high";
  }

  const router = getBrunoModelRouter();
  if (!router) {
    emitDecisionTelemetry({
      capabilityId,
      reason: "router-unavailable",
      requestedProvider: params.requestedProvider,
      requestedModel: params.requestedModel,
      sessionKey: params.sessionKey,
      traceId,
      correlationId,
    });
    return {
      kind: "fail-closed",
      reason: "router-unavailable",
      message: BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
      capabilityId,
      traceId,
      correlationId,
    };
  }

  let decision: BrunoModelRouterDecision;
  try {
    decision = await router.route(params.facts, {
      capabilityId,
      ...(traceId ? { traceId } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(forcedTier ? { forcedTier } : {}),
    });
  } catch {
    emitDecisionTelemetry({
      capabilityId,
      reason: "router-error",
      requestedProvider: params.requestedProvider,
      requestedModel: params.requestedModel,
      sessionKey: params.sessionKey,
      traceId,
      correlationId,
    });
    return {
      kind: "fail-closed",
      reason: "router-error",
      message: BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
      capabilityId,
      traceId,
      correlationId,
    };
  }

  const selectedProvider = boundedRef(decision.selectedModel?.provider);
  const selectedModel = boundedRef(decision.selectedModel?.model);
  const fallbackAlternatives = (decision.fallbackAlternatives ?? [])
    .map((candidate) => ({
      provider: boundedRef(candidate.provider) ?? "",
      model: boundedRef(candidate.model) ?? "",
    }))
    .filter((candidate) => candidate.provider !== "" && candidate.model !== "");
  const classification = decision.classification;

  // A forced HIGH request must never be downgraded to LOW/MEDIUM. The
  // canonical policy filters candidates by complexity ceiling, but verify the
  // returned classification anyway so a malformed router cannot silently
  // reclassify an owner-authorized HIGH request.
  if (forcedTier === "high" && classification?.complexity !== "high") {
    emitDecisionTelemetry({
      capabilityId,
      complexity: classification?.complexity,
      riskLevel: classification?.riskLevel,
      policyVersion: decision.policyVersion,
      reason: "high-brain-downgrade-blocked",
      requestedProvider: params.requestedProvider,
      requestedModel: params.requestedModel,
      sessionKey: params.sessionKey,
      traceId,
      correlationId,
    });
    return {
      kind: "fail-closed",
      reason: "no-acceptable-model",
      message: BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
      classification,
      capabilityId,
      traceId,
      correlationId,
    };
  }

  if (decision.reason === "no_acceptable_model" || !selectedProvider || !selectedModel) {
    emitDecisionTelemetry({
      capabilityId,
      complexity: classification?.complexity,
      riskLevel: classification?.riskLevel,
      policyVersion: decision.policyVersion,
      reason: "no-acceptable-model",
      requestedProvider: params.requestedProvider,
      requestedModel: params.requestedModel,
      sessionKey: params.sessionKey,
      traceId,
      correlationId,
    });
    return {
      kind: "fail-closed",
      reason: "no-acceptable-model",
      message: BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
      classification,
      capabilityId,
      traceId,
      correlationId,
    };
  }

  emitDecisionTelemetry({
    capabilityId,
    complexity: classification?.complexity,
    riskLevel: classification?.riskLevel,
    policyVersion: decision.policyVersion,
    reason: decision.reason,
    selectedProvider,
    selectedModel,
    requestedProvider: params.requestedProvider,
    requestedModel: params.requestedModel,
    fallbackCount: fallbackAlternatives.length,
    fallbackCandidates: fallbackAlternatives
      .slice(0, 8)
      .map((candidate) => boundedRef(`${candidate.provider}/${candidate.model}`, 160) ?? ""),
    sessionKey: params.sessionKey,
    traceId,
    correlationId,
  });
  return {
    kind: "selected",
    provider: selectedProvider,
    model: selectedModel,
    reason: decision.reason === "fallback_selected" ? "fallback_selected" : "selected",
    policyVersion: decision.policyVersion,
    fallbackAlternatives,
    classification,
    capabilityId,
    traceId,
    correlationId,
  };
}

export type BrunoModelRoutingInitializationResult =
  | { status: "disabled" }
  | { status: "initialized"; moduleSpecifier: string }
  | { status: "failed"; reason: "module-unavailable" | "invalid-module"; moduleSpecifier?: string };

let initialization: BrunoModelRoutingInitializationResult | null = null;
let initializationPromise: Promise<BrunoModelRoutingInitializationResult> | null = null;

/** Test-only reset for the process-once initialization latch. */
export function resetBrunoModelRoutingInitializationForTest(): void {
  initialization = null;
  initializationPromise = null;
  setBrunoModelRouter(null);
}

/**
 * Once-per-gateway-process startup wiring. Safe to call repeatedly; the first
 * invocation owns the work and later calls return the same settled result.
 */
export async function initializeBrunoModelRouting(params?: {
  env?: NodeJS.ProcessEnv;
  loadModule?: (specifier: string) => Promise<unknown>;
}): Promise<BrunoModelRoutingInitializationResult> {
  if (initialization) {
    return initialization;
  }
  if (initializationPromise) {
    return initializationPromise;
  }
  initializationPromise = (async () => {
    const env = params?.env ?? process.env;
    if (!isBrunoModelRoutingEnabled(env)) {
      setBrunoModelRouter(null);
      const result: BrunoModelRoutingInitializationResult = { status: "disabled" };
      initialization = result;
      log.info("bruno_model_routing_initialization", { status: "disabled" });
      return result;
    }

    const moduleSpecifier = env.OPENCLAW_BRUNO_MODEL_ROUTING_MODULE ?? "bruno-brain";
    const router = await createBrunoBrainModelRouter({
      moduleSpecifier,
      ...(params?.loadModule ? { load: () => params.loadModule!(moduleSpecifier) } : {}),
    });
    if (!router) {
      setBrunoModelRouter(null);
      const result: BrunoModelRoutingInitializationResult = {
        status: "failed",
        reason: "module-unavailable",
        moduleSpecifier,
      };
      initialization = result;
      log.warn("bruno_model_routing_initialization", {
        status: "failed",
        reason: result.reason,
        moduleSpecifier,
      });
      return result;
    }

    setBrunoModelRouter(router);
    const result: BrunoModelRoutingInitializationResult = {
      status: "initialized",
      moduleSpecifier,
    };
    initialization = result;
    log.info("bruno_model_routing_initialization", {
      status: "initialized",
      moduleSpecifier,
    });
    return result;
  })();
  return initializationPromise;
}

export type BrunoBrainRawClassification = {
  task_type?: unknown;
  complexity?: unknown;
  risk_level?: unknown;
  factors?: readonly unknown[];
  rationale?: unknown;
};

export type BrunoBrainRawDecision = {
  reason?: unknown;
  selected_model?: { provider?: unknown; model_id?: unknown } | null;
  policy_version?: unknown;
  fallback_alternatives?: readonly { provider?: unknown; model_id?: unknown }[];
  classification?: BrunoBrainRawClassification;
};

export type BrunoBrainModelRoutingModule = {
  routeModelWithPolicyForTurn?: (
    facts: unknown,
    candidates?: readonly unknown[],
    document?: unknown,
  ) => BrunoBrainRawDecision;
  /**
   * Canonical policy layer. Used only for the owner-authorized High Brain
   * override to re-rank the same Bruno-approved candidates with complexity
   * forced to HIGH; OpenClaw never hardcodes a provider or model here.
   */
  routeModelWithPolicy?: (
    request: unknown,
    candidates?: readonly unknown[],
    document?: unknown,
  ) => BrunoBrainRawDecision;
};

function mapRawReason(reason: unknown): BrunoModelRouterDecision["reason"] {
  return reason === "selected" || reason === "fallback_selected" || reason === "no_acceptable_model"
    ? reason
    : "no_acceptable_model";
}

function mapRawSelection(
  selected: { provider?: unknown; model_id?: unknown } | null | undefined,
): BrunoModelRouterSelection | null {
  return selected && typeof selected.provider === "string" && typeof selected.model_id === "string"
    ? { provider: selected.provider, model: selected.model_id }
    : null;
}

function mapRawFallbacks(
  fallbacks: readonly { provider?: unknown; model_id?: unknown }[] | undefined,
): BrunoModelRouterSelection[] | undefined {
  return Array.isArray(fallbacks)
    ? fallbacks
        .filter(
          (item): item is { provider: string; model_id: string } =>
            Boolean(item) && typeof item.provider === "string" && typeof item.model_id === "string",
        )
        .map((item) => ({ provider: item.provider, model: item.model_id }))
    : undefined;
}

function mapRawRiskLevel(riskLevel: unknown): BrunoModelRoutingClassification["riskLevel"] {
  return riskLevel === "low" ||
    riskLevel === "medium" ||
    riskLevel === "high" ||
    riskLevel === "critical"
    ? riskLevel
    : "medium";
}

function mapRawTaskType(taskType: unknown): BrunoModelRoutingClassification["taskType"] {
  return taskType === "classification" || taskType === "summarization" || taskType === "extraction"
    ? taskType
    : "reasoning";
}

function mapRawClassification(
  classification: BrunoBrainRawClassification | undefined,
): BrunoModelRoutingClassification | undefined {
  if (
    !classification ||
    typeof classification.complexity !== "string" ||
    typeof classification.risk_level !== "string"
  ) {
    return undefined;
  }
  return {
    taskType: mapRawTaskType(classification.task_type),
    complexity:
      classification.complexity === "low" ||
      classification.complexity === "medium" ||
      classification.complexity === "high"
        ? classification.complexity
        : "medium",
    riskLevel: mapRawRiskLevel(classification.risk_level),
    factors:
      Array.isArray(classification.factors) &&
      classification.factors.every((item) => typeof item === "string")
        ? classification.factors
        : undefined,
    rationale: typeof classification.rationale === "string" ? classification.rationale : undefined,
  };
}

function mapRawDecision(decision: BrunoBrainRawDecision): BrunoModelRouterDecision {
  return {
    reason: mapRawReason(decision.reason),
    selectedModel: mapRawSelection(decision.selected_model),
    fallbackAlternatives: mapRawFallbacks(decision.fallback_alternatives),
    policyVersion:
      typeof decision.policy_version === "string" ? decision.policy_version : undefined,
    classification: mapRawClassification(decision.classification),
  };
}

function buildBrunoBrainFacts(
  facts: BrunoModelRoutingFacts,
  context: { capabilityId: string; traceId?: string; correlationId?: string },
): Record<string, unknown> {
  return {
    prompt_text: facts.promptText,
    body_length: facts.bodyLength,
    is_group: facts.isGroup,
    sender_is_owner: facts.senderIsOwner,
    command_authorized: facts.commandAuthorized,
    capability_id: context.capabilityId,
    ...(context.traceId ? { trace_id: context.traceId } : {}),
    ...(context.correlationId ? { correlation_id: context.correlationId } : {}),
  };
}

/**
 * Applies the owner-authorized High Brain override by re-ranking the exact
 * Bruno-approved candidates through the canonical policy layer with
 * complexity forced to HIGH. No provider or model name appears in High Brain
 * logic; the policy resolves the configured HIGH primary and approved HIGH
 * fallback, and fails closed when no authorized HIGH route succeeds.
 */
function routeForcedHighBrainDecision(
  module: Partial<BrunoBrainModelRoutingModule>,
  semantic: BrunoBrainRawDecision,
  context: { capabilityId: string; traceId?: string; correlationId?: string },
): BrunoModelRouterDecision {
  const routeModelWithPolicy = module.routeModelWithPolicy;
  const semanticClassification = mapRawClassification(semantic.classification);
  const candidates = [
    ...(semantic.selected_model ? [semantic.selected_model] : []),
    ...(semantic.fallback_alternatives ?? []),
  ];
  const forcedClassification: BrunoModelRoutingClassification = {
    taskType: semanticClassification?.taskType ?? "reasoning",
    complexity: "high",
    riskLevel: semanticClassification?.riskLevel ?? "medium",
    factors: [
      "complexity:high",
      `risk:${semanticClassification?.riskLevel ?? "medium"}`,
      "high_brain_override",
    ],
    rationale: "Owner-authorized High Brain override forced HIGH classification.",
  };

  if (typeof routeModelWithPolicy !== "function" || candidates.length === 0) {
    return {
      reason: "no_acceptable_model",
      selectedModel: null,
      fallbackAlternatives: [],
      policyVersion:
        typeof semantic.policy_version === "string" ? semantic.policy_version : undefined,
      classification: forcedClassification,
    };
  }

  const request = {
    task_type: forcedClassification.taskType,
    complexity: "high",
    risk_level: forcedClassification.riskLevel,
    capability_id: context.capabilityId,
    ...(context.traceId ? { trace_id: context.traceId } : {}),
    ...(context.correlationId ? { correlation_id: context.correlationId } : {}),
  };

  let highDecision: BrunoBrainRawDecision;
  try {
    highDecision = routeModelWithPolicy(request, candidates) as BrunoBrainRawDecision;
  } catch {
    return {
      reason: "no_acceptable_model",
      selectedModel: null,
      fallbackAlternatives: [],
      policyVersion:
        typeof semantic.policy_version === "string" ? semantic.policy_version : undefined,
      classification: forcedClassification,
    };
  }

  const mapped = mapRawDecision(highDecision);
  return {
    ...mapped,
    classification: forcedClassification,
  };
}

/** DEV-only wiring adapter. The specifier is env-configurable; never a hardcoded path. */
export async function createBrunoBrainModelRouter(params?: {
  load?: () => Promise<unknown>;
  moduleSpecifier?: string;
}): Promise<BrunoModelRouter | null> {
  const specifier =
    params?.moduleSpecifier ?? process.env.OPENCLAW_BRUNO_MODEL_ROUTING_MODULE ?? "bruno-brain";
  const importSpecifier = path.isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
  let loaded: unknown;
  try {
    loaded = params?.load ? await params.load() : await import(importSpecifier);
  } catch {
    return null;
  }
  const module = loaded as Partial<BrunoBrainModelRoutingModule> | undefined;
  const routeModelWithPolicyForTurn = module?.routeModelWithPolicyForTurn;
  if (!module || typeof routeModelWithPolicyForTurn !== "function") {
    return null;
  }
  return {
    route(facts, context) {
      const decision = routeModelWithPolicyForTurn(
        buildBrunoBrainFacts(facts, context),
      ) as BrunoBrainRawDecision;
      if (context.forcedTier === "high") {
        return routeForcedHighBrainDecision(module, decision, context);
      }
      return mapRawDecision(decision);
    },
  };
}
