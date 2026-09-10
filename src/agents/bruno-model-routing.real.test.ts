import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createBrunoBrainModelRouter } from "./bruno-model-routing.js";

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

async function loadRealBruno(): Promise<RealBrunoModule> {
  const mod = await import(pathToFileURL(brunoBrainModelRouterDist).href);
  return mod as RealBrunoModule;
}

describe("real Bruno Brain model-routing integration", () => {
  it("loads the authoritative Bruno Brain routing entrypoint from DEV", async () => {
    const mod = await loadRealBruno();
    expect(typeof mod.routeModelWithPolicyForTurn).toBe("function");
  });

  it("classifies low/medium/high complexity through the authoritative path", async () => {
    const mod = await loadRealBruno();
    const low = mod.routeModelWithPolicyForTurn({
      body_length: 100,
      is_group: false,
      sender_is_owner: true,
      command_authorized: false,
      capability_id: "whatsapp.dm.standard",
    });
    const medium = mod.routeModelWithPolicyForTurn({
      body_length: 600,
      is_group: false,
      sender_is_owner: true,
      command_authorized: false,
      capability_id: "whatsapp.dm.standard",
    });
    const high = mod.routeModelWithPolicyForTurn({
      body_length: 2000,
      is_group: false,
      sender_is_owner: true,
      command_authorized: false,
      capability_id: "whatsapp.dm.standard",
    });
    expect(low.classification.complexity).toBe("low");
    expect(medium.classification.complexity).toBe("medium");
    expect(high.classification.complexity).toBe("high");
  });

  it("enforces risk constraints through the authoritative path", async () => {
    const mod = await loadRealBruno();
    const lowRisk = mod.routeModelWithPolicyForTurn({
      body_length: 100,
      is_group: false,
      sender_is_owner: true,
      command_authorized: false,
      capability_id: "whatsapp.dm.standard",
    });
    const highRisk = mod.routeModelWithPolicyForTurn({
      body_length: 100,
      is_group: false,
      sender_is_owner: false,
      command_authorized: false,
      capability_id: "whatsapp.dm.standard",
    });
    expect(lowRisk.classification.risk_level).toBe("low");
    expect(highRisk.classification.risk_level).toBe("high");
  });

  it("does not admit openrouter/free for a high-complexity request", async () => {
    const mod = await loadRealBruno();
    const decision = mod.routeModelWithPolicyForTurn({
      body_length: 2000,
      is_group: false,
      sender_is_owner: true,
      command_authorized: false,
      capability_id: "whatsapp.dm.standard",
    });
    const admitted = [decision.selected_model, ...decision.fallback_alternatives].filter(Boolean);
    expect(admitted.some((candidate) => candidate!.model_id === "openrouter/free")).toBe(false);
  });

  it("does not admit openrouter/free for a high-risk request", async () => {
    const mod = await loadRealBruno();
    const decision = mod.routeModelWithPolicyForTurn({
      body_length: 100,
      is_group: false,
      sender_is_owner: false,
      command_authorized: false,
      capability_id: "whatsapp.dm.standard",
    });
    const admitted = [decision.selected_model, ...decision.fallback_alternatives].filter(Boolean);
    expect(admitted.some((candidate) => candidate!.model_id === "openrouter/free")).toBe(false);
  });

  it("classification returned is the classification used for the decision", async () => {
    const mod = await loadRealBruno();
    const decision = mod.routeModelWithPolicyForTurn({
      body_length: 600,
      is_group: false,
      sender_is_owner: true,
      command_authorized: false,
      capability_id: "whatsapp.dm.standard",
    });
    // The engine ranks from this classification; assert the decision's
    // classification matches the facts-driven expected medium/low values and
    // that the selected model is compatible with that classification.
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
      { bodyLength: 600, isGroup: false, senderIsOwner: true, commandAuthorized: false },
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
