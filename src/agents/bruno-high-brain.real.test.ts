// Real Bruno Brain forced-HIGH integration: the owner-authorized High Brain
// override must resolve through the authoritative canonical policy (never a
// hardcoded model), select the current HIGH primary, retain the approved HIGH
// fallback, and never admit LOW/MEDIUM candidates.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createBrunoBrainModelRouter } from "./bruno-model-routing.js";

const brunoBrainModelRouterDist =
  process.env.OPENCLAW_BRUNO_BRAIN_DIST ??
  path.resolve(process.cwd(), "../../Bruno/bruno-brain/dist/src/model-router/index.js");

async function loadRealBruno() {
  return import(pathToFileURL(brunoBrainModelRouterDist).href);
}

describe("real Bruno Brain forced-HIGH routing", () => {
  it("resolves the forced HIGH request through the canonical policy to the current HIGH primary", async () => {
    const mod = await loadRealBruno();
    const router = await createBrunoBrainModelRouter({
      moduleSpecifier: brunoBrainModelRouterDist,
    });
    expect(router).not.toBeNull();
    const decision = await router!.route(
      {
        promptText: "What time is it in Sydney?",
        bodyLength: 30,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      { capabilityId: "whatsapp.dm.standard", forcedTier: "high", traceId: "trace-forced-high" },
    );
    expect(decision.classification?.complexity).toBe("high");
    expect(decision.reason).toBe("selected");
    expect(decision.selectedModel).toEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(mod.routeModelWithPolicyForTurn).toBeDefined();
  });

  it("retains the approved Gemini fallback for the forced HIGH decision", async () => {
    const router = await createBrunoBrainModelRouter({
      moduleSpecifier: brunoBrainModelRouterDist,
    });
    const decision = await router!.route(
      {
        promptText: "What time is it in Sydney?",
        bodyLength: 30,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      { capabilityId: "whatsapp.dm.standard", forcedTier: "high" },
    );
    const fallbackIds = (decision.fallbackAlternatives ?? []).map(
      (candidate) => `${candidate.provider}/${candidate.model}`,
    );
    expect(fallbackIds).toContain("google/gemini-3.8-flash");
  });

  it("never admits a LOW or MEDIUM candidate for the forced HIGH decision", async () => {
    const router = await createBrunoBrainModelRouter({
      moduleSpecifier: brunoBrainModelRouterDist,
    });
    const decision = await router!.route(
      {
        promptText: "What time is it in Sydney?",
        bodyLength: 30,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      { capabilityId: "whatsapp.dm.standard", forcedTier: "high" },
    );
    const admitted = [decision.selectedModel, ...(decision.fallbackAlternatives ?? [])].filter(
      (candidate): candidate is { provider: string; model: string } => Boolean(candidate),
    );
    expect(admitted.some((candidate) => candidate.model === "openrouter/free")).toBe(false);
    expect(admitted.some((candidate) => candidate.model === "deepseek-v4-flash")).toBe(false);
    expect(admitted.length).toBeGreaterThan(0);
  });

  it("routes an ordinary semantic LOW query without the override", async () => {
    const router = await createBrunoBrainModelRouter({
      moduleSpecifier: brunoBrainModelRouterDist,
    });
    const decision = await router!.route(
      {
        promptText: "What time is it in Sydney?",
        bodyLength: 30,
        isGroup: false,
        senderIsOwner: true,
        commandAuthorized: false,
      },
      { capabilityId: "whatsapp.dm.standard" },
    );
    expect(decision.classification?.complexity).toBe("low");
    expect(decision.selectedModel).toEqual({ provider: "openrouter", model: "openrouter/free" });
  });
});
