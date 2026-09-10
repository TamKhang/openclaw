/**
 * DEV-only bridge that asks Bruno Model Routing to decide the model for an
 * ordinary agent/WhatsApp conversational turn *before* OpenClaw executes a
 * provider. OpenClaw owns only the narrow port below; Bruno Brain owns the
 * classification, candidate tiers, policy, and the actual routing engine.
 *
 * The bridge is side-effect free apart from bounded telemetry. It never logs
 * prompt content, credentials, keys, or user data.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveTrustedBrunoRoutingCapability,
  type TrustedBrunoRoutingCapability,
} from "./bruno-routing-capability.js";

const log = createSubsystemLogger("bruno-model-routing");

export type BrunoModelRoutingFacts = {
  /** Bounded prompt size only. Never the prompt text. */
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
    context: { capabilityId: string; traceId?: string; correlationId?: string },
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
  scope: { messageProvider?: string | null; chatType?: string | null };
  facts: BrunoModelRoutingFacts;
  sessionKey?: string;
  traceId?: string;
  correlationId?: string;
  requestedProvider?: string;
  requestedModel?: string;
}): Promise<BrunoModelRoutingTurnResult> {
  if (!params.enabled) {
    return { kind: "not-applicable" };
  }

  const capabilityId = resolveTrustedBrunoRoutingCapability({
    messageProvider: params.scope.messageProvider,
    chatType: params.scope.chatType,
  });
  if (!capabilityId) {
    return { kind: "not-applicable" };
  }

  const traceId = boundedRef(params.traceId);
  const correlationId = boundedRef(params.correlationId) ?? boundedRef(params.sessionKey);

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

export type BrunoBrainModelRoutingModule = {
  routeModelWithPolicyForTurn?: (
    facts: unknown,
    candidates?: readonly unknown[],
    document?: unknown,
  ) => {
    reason?: unknown;
    selected_model?: { provider?: unknown; model_id?: unknown } | null;
    policy_version?: unknown;
    fallback_alternatives?: readonly { provider?: unknown; model_id?: unknown }[];
    classification?: {
      task_type?: unknown;
      complexity?: unknown;
      risk_level?: unknown;
      factors?: readonly unknown[];
      rationale?: unknown;
    };
  };
};

/** DEV-only wiring adapter. The specifier is env-configurable; never a hardcoded path. */
export async function createBrunoBrainModelRouter(params?: {
  load?: () => Promise<unknown>;
  moduleSpecifier?: string;
}): Promise<BrunoModelRouter | null> {
  const specifier =
    params?.moduleSpecifier ?? process.env.OPENCLAW_BRUNO_MODEL_ROUTING_MODULE ?? "bruno-brain";
  let loaded: unknown;
  try {
    loaded = params?.load ? await params.load() : await import(specifier);
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
      const decision = routeModelWithPolicyForTurn({
        body_length: facts.bodyLength,
        is_group: facts.isGroup,
        sender_is_owner: facts.senderIsOwner,
        command_authorized: facts.commandAuthorized,
        capability_id: context.capabilityId,
        ...(context.traceId ? { trace_id: context.traceId } : {}),
        ...(context.correlationId ? { correlation_id: context.correlationId } : {}),
      });
      const selected = decision.selected_model;
      const classification = decision.classification;
      return {
        reason:
          decision.reason === "selected" ||
          decision.reason === "fallback_selected" ||
          decision.reason === "no_acceptable_model"
            ? decision.reason
            : "no_acceptable_model",
        selectedModel:
          selected && typeof selected.provider === "string" && typeof selected.model_id === "string"
            ? { provider: selected.provider, model: selected.model_id }
            : null,
        fallbackAlternatives: Array.isArray(decision.fallback_alternatives)
          ? decision.fallback_alternatives
              .filter(
                (item): item is { provider: string; model_id: string } =>
                  Boolean(item) &&
                  typeof item.provider === "string" &&
                  typeof item.model_id === "string",
              )
              .map((item) => ({ provider: item.provider, model: item.model_id }))
          : undefined,
        policyVersion:
          typeof decision.policy_version === "string" ? decision.policy_version : undefined,
        classification:
          classification &&
          typeof classification.complexity === "string" &&
          typeof classification.risk_level === "string"
            ? {
                taskType:
                  classification.task_type === "classification" ||
                  classification.task_type === "summarization" ||
                  classification.task_type === "extraction"
                    ? classification.task_type
                    : "reasoning",
                complexity:
                  classification.complexity === "low" ||
                  classification.complexity === "medium" ||
                  classification.complexity === "high"
                    ? classification.complexity
                    : "medium",
                riskLevel:
                  classification.risk_level === "low" ||
                  classification.risk_level === "medium" ||
                  classification.risk_level === "high" ||
                  classification.risk_level === "critical"
                    ? classification.risk_level
                    : "medium",
                factors:
                  Array.isArray(classification.factors) &&
                  classification.factors.every((item) => typeof item === "string")
                    ? classification.factors
                    : undefined,
                rationale:
                  typeof classification.rationale === "string"
                    ? classification.rationale
                    : undefined,
              }
            : undefined,
      };
    },
  };
}
