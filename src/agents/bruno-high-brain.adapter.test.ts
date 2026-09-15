// Adapter coverage for the forced-HIGH path: the canonical policy layer
// (`routeModelWithPolicy`) is called with complexity forced to HIGH and the
// exact Bruno-approved candidates, the resolved provider/model is passed
// through unchanged (never hardcoded), and a module without the canonical
// policy layer fails closed.
import { describe, expect, it, vi } from "vitest";
import { createBrunoBrainModelRouter } from "./bruno-model-routing.js";

function semanticModule() {
  const routeModelWithPolicy = vi.fn(() => ({
    reason: "selected",
    selected_model: { provider: "deepseek", model_id: "deepseek-flash" },
    policy_version: "model-router-v0.1",
    fallback_alternatives: [{ provider: "google", model_id: "gemini-3.8-flash" }],
    availability_checked: true,
    factors: [],
    confidence: 0.9,
  }));
  return {
    routeModelWithPolicy,
    routeModelWithPolicyForTurn: () => ({
      reason: "selected",
      selected_model: { provider: "deepseek", model_id: "deepseek-v4-flash" },
      policy_version: "model-router-v0.1",
      fallback_alternatives: [
        { provider: "openrouter", model_id: "openrouter/free" },
        { provider: "deepseek", model_id: "deepseek-flash" },
        { provider: "google", model_id: "gemini-3.8-flash" },
      ],
      classification: {
        task_type: "reasoning",
        complexity: "low",
        risk_level: "low",
        factors: ["complexity:low"],
        rationale: "classified",
      },
    }),
  };
}

describe("createBrunoBrainModelRouter forced-HIGH path", () => {
  it("calls the canonical policy layer with complexity forced to HIGH", async () => {
    const module = semanticModule();
    const router = await createBrunoBrainModelRouter({ load: async () => module });
    expect(router).not.toBeNull();
    const decision = await router!.route(
      {
        promptText: "hello",
        bodyLength: 5,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      { capabilityId: "whatsapp.dm.standard", forcedTier: "high" },
    );
    expect(decision.classification?.complexity).toBe("high");
    expect(decision.reason).toBe("selected");
    // Provider/model identity comes from the canonical policy output, not from
    // any High Brain hardcoding.
    expect(decision.selectedModel).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(module.routeModelWithPolicy).toHaveBeenCalledTimes(1);
    const [request, candidates] = module.routeModelWithPolicy.mock.calls[0] as unknown as [
      { complexity: string; risk_level: string; task_type: string },
      unknown[],
    ];
    expect(request.complexity).toBe("high");
    expect(request.risk_level).toBe("low");
    expect(request.task_type).toBe("reasoning");
    expect(candidates).toHaveLength(4);
  });

  it("keeps the approved fallback alternatives from the canonical policy output", async () => {
    const module = semanticModule();
    const router = await createBrunoBrainModelRouter({ load: async () => module });
    const decision = await router!.route(
      {
        promptText: "hello",
        bodyLength: 5,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      { capabilityId: "whatsapp.dm.standard", forcedTier: "high" },
    );
    expect(decision.fallbackAlternatives).toEqual([
      { provider: "google", model: "gemini-3.8-flash" },
    ]);
  });

  it("fails closed when the module lacks the canonical policy layer", async () => {
    const router = await createBrunoBrainModelRouter({
      load: async () => ({
        routeModelWithPolicyForTurn: () => ({
          reason: "selected",
          selected_model: { provider: "deepseek", model_id: "deepseek-v4-flash" },
          policy_version: "model-router-v0.1",
          fallback_alternatives: [{ provider: "google", model_id: "gemini-3.8-flash" }],
          classification: { task_type: "reasoning", complexity: "low", risk_level: "low" },
        }),
      }),
    });
    expect(router).not.toBeNull();
    const decision = await router!.route(
      {
        promptText: "hello",
        bodyLength: 5,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      { capabilityId: "whatsapp.dm.standard", forcedTier: "high" },
    );
    expect(decision.reason).toBe("no_acceptable_model");
    expect(decision.selectedModel).toBeNull();
    expect(decision.classification?.complexity).toBe("high");
  });

  it("passes forced HIGH through without naming a provider or model in the override", async () => {
    const module = semanticModule();
    const router = await createBrunoBrainModelRouter({ load: async () => module });
    const decision = await router!.route(
      {
        promptText: "hello",
        bodyLength: 5,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      { capabilityId: "whatsapp.dm.standard", forcedTier: "high" },
    );
    expect(decision.classification?.factors).toContain("high_brain_override");
    expect(decision.classification?.factors).not.toContain("deepseek-flash");
    expect(decision.classification?.rationale).not.toContain("deepseek-flash");
  });
});
