import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBrunoBrainModelRouter,
  getBrunoModelRouter,
  initializeBrunoModelRouting,
  resetBrunoModelRoutingInitializationForTest,
  routeConversationalTurnWithBruno,
} from "./bruno-model-routing.js";

const brunoBrainModelRouterDist =
  process.env.OPENCLAW_BRUNO_BRAIN_DIST ??
  path.resolve(process.cwd(), "../../Bruno/bruno-brain/dist/src/model-router/index.js");

type RealBrunoModule = typeof import("./bruno-model-routing.js") & {
  routeModelWithPolicyForTurn: (facts: Record<string, unknown>) => {
    reason: "selected" | "fallback_selected" | "no_acceptable_model";
    selected_model: { provider: string; model_id: string } | null;
    policy_version: string;
    fallback_alternatives: Array<{ provider: string; model_id: string }>;
    classification: {
      task_type: string;
      complexity: "low" | "medium" | "high";
      risk_level: "low" | "medium" | "high" | "critical";
    };
  };
};

// Semantic complexity is derived from prompt_text; body_length is metadata only.
const LOW_PROMPT = "What time is it in Sydney right now?";
const MEDIUM_PROMPT =
  "Compare optimistic and pessimistic concurrency control for a distributed job queue and recommend one.";
const HIGH_PROMPT =
  "Plan the multi-stage production rollout and certification for migrating our dev GitHub pipeline to prod, covering staging, pre-prod and production gates with rollback verification.";

function facts(promptText: string, senderIsOwner = true) {
  return {
    prompt_text: promptText,
    body_length: promptText.length,
    is_group: false,
    sender_is_owner: senderIsOwner,
    command_authorized: false,
    capability_id: "whatsapp.dm.standard",
  };
}

afterEach(() => {
  resetBrunoModelRoutingInitializationForTest();
});

async function loadRealBruno(): Promise<RealBrunoModule> {
  const mod = await import(pathToFileURL(brunoBrainModelRouterDist).href);
  return mod as RealBrunoModule;
}

describe("real Bruno Brain model-routing integration", () => {
  it("loads the authoritative Bruno Brain routing entrypoint from DEV", async () => {
    const mod = await loadRealBruno();
    expect(typeof mod.routeModelWithPolicyForTurn).toBe("function");
  });

  it("classifies low/medium/high complexity from prompt_text through the authoritative path", async () => {
    const mod = await loadRealBruno();
    const low = mod.routeModelWithPolicyForTurn(facts(LOW_PROMPT));
    const medium = mod.routeModelWithPolicyForTurn(facts(MEDIUM_PROMPT));
    const high = mod.routeModelWithPolicyForTurn(facts(HIGH_PROMPT));
    expect(low.classification.complexity).toBe("low");
    expect(medium.classification.complexity).toBe("medium");
    expect(high.classification.complexity).toBe("high");
  });

  it("routes LOW to openrouter/free, MEDIUM to deepseek-v4-flash, HIGH to deepseek-flash", async () => {
    const mod = await loadRealBruno();
    const low = mod.routeModelWithPolicyForTurn(facts(LOW_PROMPT));
    const medium = mod.routeModelWithPolicyForTurn(facts(MEDIUM_PROMPT));
    const high = mod.routeModelWithPolicyForTurn(facts(HIGH_PROMPT));
    expect(low.selected_model?.model_id).toBe("openrouter/free");
    expect(medium.selected_model?.model_id).toBe("deepseek-v4-flash");
    expect(high.selected_model?.model_id).toBe("deepseek-flash");
  });

  it("keeps Gemini as an approved fallback, never as a routing tier", async () => {
    const mod = await loadRealBruno();
    for (const prompt of [LOW_PROMPT, MEDIUM_PROMPT, HIGH_PROMPT]) {
      const decision = mod.routeModelWithPolicyForTurn(facts(prompt));
      expect(decision.fallback_alternatives.map((c) => `${c.provider}/${c.model_id}`)).toContain(
        "google/gemini-3.8-flash",
      );
    }
  });

  it("does not force HIGH or a premium tier from the Bruno, come in trigger text", async () => {
    const mod = await loadRealBruno();
    const decision = mod.routeModelWithPolicyForTurn(facts("Bruno, come in"));
    expect(decision.classification.complexity).toBe("low");
    expect(decision.selected_model?.model_id).toBe("openrouter/free");
  });

  it("enforces risk constraints through the authoritative path", async () => {
    const mod = await loadRealBruno();
    const lowRisk = mod.routeModelWithPolicyForTurn(facts(LOW_PROMPT, true));
    const highRisk = mod.routeModelWithPolicyForTurn(facts(LOW_PROMPT, false));
    expect(lowRisk.classification.risk_level).toBe("low");
    expect(highRisk.classification.risk_level).toBe("high");
  });

  it("does not admit openrouter/free for a high-complexity request", async () => {
    const mod = await loadRealBruno();
    const decision = mod.routeModelWithPolicyForTurn(facts(HIGH_PROMPT));
    const admitted = [decision.selected_model, ...decision.fallback_alternatives].filter(Boolean);
    expect(admitted.some((candidate) => candidate!.model_id === "openrouter/free")).toBe(false);
  });

  it("does not admit openrouter/free for a high-risk request", async () => {
    const mod = await loadRealBruno();
    const decision = mod.routeModelWithPolicyForTurn(facts(LOW_PROMPT, false));
    const admitted = [decision.selected_model, ...decision.fallback_alternatives].filter(Boolean);
    expect(admitted.some((candidate) => candidate!.model_id === "openrouter/free")).toBe(false);
  });

  it("classification returned is the classification used for the decision", async () => {
    const mod = await loadRealBruno();
    const decision = mod.routeModelWithPolicyForTurn(facts(MEDIUM_PROMPT));
    expect(decision.classification).toMatchObject({
      complexity: "medium",
      risk_level: "low",
    });
    expect(decision.selected_model).not.toBeNull();
    expect(decision.reason).toBe("selected");
  });

  it("wires the OpenClaw adapter to the real Bruno Brain implementation", async () => {
    const router = await createBrunoBrainModelRouter({
      moduleSpecifier: brunoBrainModelRouterDist,
      load: async () => import(pathToFileURL(brunoBrainModelRouterDist).href),
    });
    expect(router).not.toBeNull();
    const decision = await router!.route(
      {
        promptText: MEDIUM_PROMPT,
        bodyLength: MEDIUM_PROMPT.length,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      { capabilityId: "whatsapp.dm.standard", traceId: "trace-real-1" },
    );
    expect(decision.reason).toBe("selected");
    expect(decision.selectedModel).not.toBeNull();
    expect(decision.classification).toMatchObject({
      complexity: "medium",
      riskLevel: "low",
    });
    expect(decision.fallbackAlternatives?.length).toBeGreaterThan(0);
  });
});

describe("real Bruno Brain startup wiring", () => {
  it("loads the configured absolute compiled module path", async () => {
    const router = await createBrunoBrainModelRouter({
      moduleSpecifier: brunoBrainModelRouterDist,
    });
    expect(router).not.toBeNull();
  });

  it("initializes once and routes an ordinary turn through the real Bruno Brain", async () => {
    const result = await initializeBrunoModelRouting({
      env: {
        OPENCLAW_BRUNO_MODEL_ROUTING: "1",
        OPENCLAW_BRUNO_MODEL_ROUTING_MODULE: brunoBrainModelRouterDist,
      },
    });
    expect(result).toEqual({ status: "initialized", moduleSpecifier: brunoBrainModelRouterDist });
    expect(getBrunoModelRouter()).not.toBeNull();

    const turn = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: { messageProvider: "whatsapp", chatType: "direct" },
      facts: {
        promptText: MEDIUM_PROMPT,
        bodyLength: MEDIUM_PROMPT.length,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      sessionKey: "agent:main:whatsapp:real",
      traceId: "trace-real-startup",
    });
    expect(turn.kind).toBe("selected");
    if (turn.kind === "selected") {
      expect(turn.classification).toMatchObject({ complexity: "medium", riskLevel: "low" });
      expect(turn.fallbackAlternatives.length).toBeGreaterThan(0);
    }
  });
});
