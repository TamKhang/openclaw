// Routing-bridge coverage for the owner-authorized one-shot High Brain
// override: the override must force exactly one HIGH classification through
// the existing Bruno routing seam, fail closed when missing/consumed, never
// downgrade to LOW/MEDIUM, and never leak into a following or concurrent turn.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerBrunoHighBrainOverride,
  resetBrunoHighBrainOverrideForTests,
} from "./bruno-high-brain.js";
import {
  BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
  resetBrunoModelRoutingInitializationForTest,
  routeConversationalTurnWithBruno,
  setBrunoModelRouter,
  type BrunoModelRouterDecision,
} from "./bruno-model-routing.js";

const facts = {
  promptText: "What time is it in Sydney?",
  bodyLength: 30,
  isGroup: false,
  senderIsOwner: true,
  commandAuthorized: false,
};

const whatsappDm = { messageProvider: "whatsapp", chatType: "direct" };

function registerOverride(sourceEventId: string): void {
  const now = Date.now();
  registerBrunoHighBrainOverride({
    policyVersion: 1,
    sourceEventId,
    mode: "dm",
    requestedTier: "high",
    createdAt: now,
    expiresAt: now + 120_000,
  });
}

function capturingRouter(): {
  route: (facts: unknown, context: { forcedTier?: string }) => BrunoModelRouterDecision;
  calls: Array<{ forcedTier?: string }>;
} {
  const calls: Array<{ forcedTier?: string }> = [];
  return {
    calls,
    route: (_facts, context) => {
      calls.push({ forcedTier: context.forcedTier });
      return {
        reason: "selected",
        selectedModel: { provider: "deepseek", model: "deepseek-flash" },
        policyVersion: "model-router-v0.1",
        fallbackAlternatives: [{ provider: "google", model: "gemini-3.8-flash" }],
        classification: {
          taskType: "reasoning",
          complexity: context.forcedTier === "high" ? "high" : "low",
          riskLevel: "low",
        },
      };
    },
  };
}

afterEach(() => {
  resetBrunoHighBrainOverrideForTests();
  resetBrunoModelRoutingInitializationForTest();
});

describe("routeConversationalTurnWithBruno High Brain override", () => {
  it("forces exactly one HIGH classification for a registered override", async () => {
    registerOverride("event-1");
    const router = capturingRouter();
    setBrunoModelRouter(router);

    const first = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
      highBrainSourceEventId: "event-1",
    });
    expect(first.kind).toBe("selected");
    if (first.kind === "selected") {
      expect(first.classification?.complexity).toBe("high");
      expect(first.model).toBe("deepseek-flash");
    }
    expect(router.calls).toEqual([{ forcedTier: "high" }]);
  });

  it("consumes the override once and does not force HIGH on the next turn", async () => {
    registerOverride("event-1");
    const router = capturingRouter();
    setBrunoModelRouter(router);

    await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
      highBrainSourceEventId: "event-1",
    });
    const next = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
    });
    expect(next.kind).toBe("selected");
    if (next.kind === "selected") {
      expect(next.classification?.complexity).toBe("low");
    }
    expect(router.calls).toEqual([{ forcedTier: "high" }, {}]);
  });

  it("fails closed when the override is missing", async () => {
    setBrunoModelRouter(capturingRouter());
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
      highBrainSourceEventId: "never-registered",
    });
    expect(result).toMatchObject({
      kind: "fail-closed",
      reason: "no-acceptable-model",
      message: BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
    });
  });

  it("fails closed when the override was already consumed", async () => {
    registerOverride("event-1");
    const router = capturingRouter();
    setBrunoModelRouter(router);
    await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
      highBrainSourceEventId: "event-1",
    });
    const replay = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
      highBrainSourceEventId: "event-1",
    });
    expect(replay.kind).toBe("fail-closed");
    expect(router.calls).toHaveLength(1);
  });

  it("isolates concurrent turns by source event identity", async () => {
    registerOverride("event-a");
    registerOverride("event-b");
    const router = capturingRouter();
    setBrunoModelRouter(router);

    const [a, b] = await Promise.all([
      routeConversationalTurnWithBruno({
        enabled: true,
        scope: whatsappDm,
        facts,
        highBrainSourceEventId: "event-a",
      }),
      routeConversationalTurnWithBruno({
        enabled: true,
        scope: whatsappDm,
        facts,
        highBrainSourceEventId: "event-b",
      }),
    ]);
    expect(a.kind).toBe("selected");
    expect(b.kind).toBe("selected");
    expect(router.calls.map((call) => call.forcedTier).sort()).toEqual(["high", "high"]);
  });

  it("never downgrades a forced HIGH request to LOW or MEDIUM", async () => {
    registerOverride("event-1");
    setBrunoModelRouter({
      route: () => ({
        reason: "selected",
        selectedModel: { provider: "openrouter", model: "openrouter/free" },
        policyVersion: "model-router-v0.1",
        fallbackAlternatives: [],
        classification: {
          taskType: "reasoning",
          complexity: "low",
          riskLevel: "low",
        },
      }),
    });
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
      highBrainSourceEventId: "event-1",
    });
    expect(result).toMatchObject({
      kind: "fail-closed",
      reason: "no-acceptable-model",
      message: BRUNO_MODEL_ROUTING_FAIL_CLOSED_TEXT,
    });
  });

  it("does not activate outside a trusted WhatsApp scope", async () => {
    registerOverride("event-1");
    const router = capturingRouter();
    setBrunoModelRouter(router);
    const result = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: { messageProvider: "telegram", chatType: "direct" },
      facts,
      highBrainSourceEventId: "event-1",
    });
    expect(result.kind).toBe("not-applicable");
    expect(router.calls).toHaveLength(0);
  });

  it("does not claim the override when the DEV gate is disabled", async () => {
    registerOverride("event-1");
    const result = await routeConversationalTurnWithBruno({
      enabled: false,
      scope: whatsappDm,
      facts,
      highBrainSourceEventId: "event-1",
    });
    expect(result.kind).toBe("not-applicable");
    // The override remains claimable for a later enabled turn.
    const router = capturingRouter();
    setBrunoModelRouter(router);
    const later = await routeConversationalTurnWithBruno({
      enabled: true,
      scope: whatsappDm,
      facts,
      highBrainSourceEventId: "event-1",
    });
    expect(later.kind).toBe("selected");
    if (later.kind === "selected") {
      expect(later.classification?.complexity).toBe("high");
    }
  });
});
