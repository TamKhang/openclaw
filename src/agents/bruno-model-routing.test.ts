import { afterEach, describe, expect, it } from "vitest";
import {
  BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
  createBrunoBrainModelRouter,
  isBrunoModelRoutingEnabled,
  routeConversationalTurnWithBruno,
  setBrunoModelRouter,
  type BrunoModelRouter,
  type BrunoModelRouterDecision,
} from "./bruno-model-routing.js";

function routerReturning(decision: BrunoModelRouterDecision): BrunoModelRouter {
  return { route: () => decision };
}

const deepseekFlash: BrunoModelRouterDecision = {
  reason: "selected",
  selectedModel: { provider: "deepseek", model: "deepseek-v4-flash" },
  policyVersion: "model-router-v0.1",
  fallbackAlternatives: [{ provider: "google", model: "gemini-3.8-flash" }],
  classification: {
    taskType: "reasoning",
    complexity: "medium",
    riskLevel: "low",
  },
};

const facts = {
  bodyLength: 600,
  isGroup: false,
  senderIsOwner: true,
  commandAuthorized: false,
};

const whatsappDm = { messageProvider: "whatsapp", chatType: "direct" };

afterEach(() => {
  setBrunoModelRouter(null);
});

describe("isBrunoModelRoutingEnabled", () => {
  it("is off by default", () => {
    expect(isBrunoModelRoutingEnabled({})).toBe(false);
  });

  it.each(["1", "true", "on"])("enables on %s", (raw) => {
    expect(isBrunoModelRoutingEnabled({ OPENCLAW_BRUNO_MODEL_ROUTING: raw })).toBe(true);
  });
});

describe("routeConversationalTurnWithBruno", () => {
  it("stays not-applicable when the DEV gate is disabled", async () => {
    setBrunoModelRouter(routerReturning(deepseekFlash));
    const result = await routeConversationalTurnWithBruno({
      enabled: false,
      scope: whatsappDm,
      facts,
      sessionKey: "agent:main:whatsapp:1",
    });
    expect(result.kind).toBe("not-applicable");
  });

  it("stays not-applicable outside WhatsApp trusted scope", async () => {
    setBrunoModelRouter(routerReturning(deepseekFlash));
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: { messageProvider: "telegram", chatType: "direct" },
      facts,
    });
    expect(result.kind).toBe("not-applicable");
  });

  it("fails closed when no router is wired", async () => {
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
    });
    expect(result).toMatchObject({
      kind: "fail-closed",
      reason: "router-unavailable",
      message: BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
    });
  });

  it("fails closed when the router throws", async () => {
    setBrunoModelRouter({
      route: () => {
        throw new Error("boom");
      },
    });
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
    });
    expect(result).toMatchObject({ kind: "fail-closed", reason: "router-error" });
  });

  it("fails closed on no-acceptable-model", async () => {
    setBrunoModelRouter(
      routerReturning({
        reason: "no_acceptable_model",
        selectedModel: null,
        fallbackAlternatives: [],
        classification: { taskType: "reasoning", complexity: "high", riskLevel: "high" },
      }),
    );
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts: { ...facts, bodyLength: 2000, senderIsOwner: false },
    });
    expect(result).toMatchObject({ kind: "fail-closed", reason: "no-acceptable-model" });
  });

  it("selects the router decision and carries the authoritative classification", async () => {
    setBrunoModelRouter(routerReturning(deepseekFlash));
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
      sessionKey: "agent:main:whatsapp:1",
      traceId: "trace-1",
    });
    expect(result).toMatchObject({
      kind: "selected",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      classification: { complexity: "medium", riskLevel: "low" },
    });
  });

  it("carries only Bruno-approved fallback alternatives", async () => {
    setBrunoModelRouter(routerReturning(deepseekFlash));
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
    });
    expect(result.kind).toBe("selected");
    if (result.kind === "selected") {
      expect(result.fallbackAlternatives).toEqual([
        { provider: "google", model: "gemini-3.8-flash" },
      ]);
    }
  });

  it("passes provider/model identity from the router through unchanged", async () => {
    setBrunoModelRouter(
      routerReturning({
        reason: "selected",
        selectedModel: { provider: "google", model: "gemini-3.8-flash" },
        policyVersion: "model-router-v0.1",
        fallbackAlternatives: [],
        classification: { taskType: "reasoning", complexity: "medium", riskLevel: "low" },
      }),
    );
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
    });
    expect(result).toMatchObject({
      kind: "selected",
      provider: "google",
      model: "gemini-3.8-flash",
    });
  });

  it("treats a policy-governed fallback selection as a selected route", async () => {
    setBrunoModelRouter(
      routerReturning({
        reason: "fallback_selected",
        selectedModel: { provider: "openrouter", model: "openrouter/free" },
        policyVersion: "model-router-v0.1",
        fallbackAlternatives: [],
        classification: { taskType: "reasoning", complexity: "low", riskLevel: "low" },
      }),
    );
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
    });
    expect(result).toMatchObject({
      kind: "selected",
      reason: "fallback_selected",
      provider: "openrouter",
      model: "openrouter/free",
    });
  });
});

describe("createBrunoBrainModelRouter adapter", () => {
  it("adapts the authoritative routeModelWithPolicyForTurn output to the OpenClaw port", async () => {
    const router = await createBrunoBrainModelRouter({
      load: async () => ({
        routeModelWithPolicyForTurn: (facts: Record<string, unknown>) => ({
          reason: "selected",
          selected_model: { provider: "deepseek", model_id: "deepseek-v4-flash" },
          policy_version: "model-router-v0.1",
          fallback_alternatives: [{ provider: "google", model_id: "gemini-3.8-flash" }],
          classification: {
            task_type: "reasoning",
            complexity: "medium",
            risk_level: "low",
            factors: ["body_length:medium", "authorization:low"],
            rationale: "classified",
          },
        }),
      }),
    });
    expect(router).not.toBeNull();
    const decision = await router!.route(
      { bodyLength: 600, isGroup: false, senderIsOwner: true, commandAuthorized: false },
      { capabilityId: "whatsapp.dm.standard" },
    );
    expect(decision).toMatchObject({
      reason: "selected",
      selectedModel: { provider: "deepseek", model: "deepseek-v4-flash" },
      policyVersion: "model-router-v0.1",
      fallbackAlternatives: [{ provider: "google", model: "gemini-3.8-flash" }],
      classification: {
        taskType: "reasoning",
        complexity: "medium",
        riskLevel: "low",
      },
    });
  });

  it("returns null when the configured module is unavailable", async () => {
    const router = await createBrunoBrainModelRouter({
      moduleSpecifier: "bruno-brain-not-installed",
      load: async () => {
        throw new Error("cannot resolve module");
      },
    });
    expect(router).toBeNull();
  });

  it("returns null when the module lacks routeModelWithPolicyForTurn", async () => {
    const router = await createBrunoBrainModelRouter({
      load: async () => ({}),
    });
    expect(router).toBeNull();
  });
});
