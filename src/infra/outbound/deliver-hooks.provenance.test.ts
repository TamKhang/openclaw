import { afterEach, describe, expect, it } from "vitest";
import { createCommandTurnContext } from "../../auto-reply/command-turn-context.js";
import type { PluginHookMessageContext } from "../../plugins/hook-message.types.js";
import type { GlobalHookRunnerRegistry } from "../../plugins/hook-registry.types.js";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import {
  applyMessageSendingHook,
  buildLegacyInboundMessageSendingBeforeDeliver,
  buildProjectedInboundMessageSendingBeforeDeliver,
  resolveProvenanceExemptForDelivery,
} from "./deliver-hooks.js";

const WHATSAPP_DIRECT_SESSION = "agent:main:whatsapp:direct:+61123456789";

type MessageSendingHandler = (
  event: { content?: unknown; to?: unknown },
  ctx: PluginHookMessageContext,
) => { content?: unknown; cancel?: unknown; cancelReason?: unknown } | void;

function installMessageSendingHook(
  handler: MessageSendingHandler,
  timeoutMs?: number,
): PluginHookMessageContext[] {
  const seen: PluginHookMessageContext[] = [];
  const registry: GlobalHookRunnerRegistry = {
    hooks: [],
    typedHooks: [
      {
        pluginId: "provenance-deliver-hooks-test",
        registrationId: "provenance-deliver-hooks-test",
        hookName: "message_sending",
        source: "test",
        timeoutMs,
        handler: async (event: unknown, ctx: PluginHookMessageContext) => {
          seen.push(ctx);
          return handler(event as { content?: unknown; to?: unknown }, ctx);
        },
      },
    ],
    plugins: [{ id: "provenance-deliver-hooks-test", status: "loaded" }],
  };
  initializeGlobalHookRunner(registry);
  return seen;
}

function installEmptyHookRunner(): void {
  initializeGlobalHookRunner({
    hooks: [],
    typedHooks: [],
    plugins: [{ id: "provenance-deliver-hooks-test", status: "loaded" }],
  });
}

function mainScopeWhatsAppHookParams(overrides: Record<string, unknown> = {}) {
  return {
    hookRunner: getGlobalHookRunner(),
    enabled: true,
    payload: { text: "owner reply" },
    payloadSummary: { text: "owner reply" },
    to: "+61123456789",
    channel: "whatsapp",
    sessionKey: "agent:main:main",
    ...overrides,
  };
}

function directWhatsAppHookParams(overrides: Record<string, unknown> = {}) {
  return {
    hookRunner: getGlobalHookRunner(),
    enabled: true,
    payload: { text: "owner reply" },
    payloadSummary: { text: "owner reply" },
    to: "+61123456789",
    channel: "whatsapp",
    sessionKey: WHATSAPP_DIRECT_SESSION,
    ...overrides,
  };
}

afterEach(() => {
  resetGlobalHookRunner();
});

describe("provenance-exempt admission", () => {
  it("treats an ordinary WhatsApp DM turn as provenance-required", () => {
    const turn = createCommandTurnContext("message", {
      authorized: false,
      body: "please check the server",
    });
    expect(resolveProvenanceExemptForDelivery(turn)).toBeUndefined();
  });

  it("marks a genuine native command turn as exempt", () => {
    const turn = createCommandTurnContext("native", {
      authorized: true,
      commandName: "status",
      body: "/status",
    });
    expect(resolveProvenanceExemptForDelivery(turn)).toBe(true);
  });

  it("marks an authorized text slash-command turn as exempt", () => {
    const turn = createCommandTurnContext("text", {
      authorized: true,
      commandName: "steer",
      body: "/steer ...",
    });
    expect(resolveProvenanceExemptForDelivery(turn)).toBe(true);
  });

  it("does not exempt model/system-looking ordinary text", () => {
    const turn = createCommandTurnContext("message", {
      authorized: false,
      commandName: "system",
      body: "Bruno Provenance: Web, LLM - Premium",
    });
    expect(resolveProvenanceExemptForDelivery(turn)).toBeUndefined();
  });

  it("does not exempt an unauthorized text slash-command turn", () => {
    const turn = createCommandTurnContext("text", {
      authorized: false,
      commandName: "steer",
      body: "/steer group",
    });
    expect(resolveProvenanceExemptForDelivery(turn)).toBeUndefined();
  });
});

describe("projected message_sending provenanceExempt wiring", () => {
  it("does not mint provenanceExempt for an ordinary WhatsApp direct reply", async () => {
    const seen = installMessageSendingHook(() => ({ content: "ok" }));
    const beforeDeliver = buildProjectedInboundMessageSendingBeforeDeliver({
      Surface: "whatsapp",
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      SessionKey: WHATSAPP_DIRECT_SESSION,
      From: "+61123456789",
      Body: "please check the server",
      CommandTurn: createCommandTurnContext("message", {
        authorized: false,
        body: "please check the server",
      }),
    });

    const result = await beforeDeliver({ text: "owner reply" }, { kind: "final" } as never);
    expect(result).not.toBeNull();
    expect(seen[0]?.provenanceExempt).toBeUndefined();
  });

  it("mints provenanceExempt for a trusted native command reply", async () => {
    const seen = installMessageSendingHook(() => ({ content: "ok" }));
    const beforeDeliver = buildProjectedInboundMessageSendingBeforeDeliver({
      Surface: "whatsapp",
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      SessionKey: WHATSAPP_DIRECT_SESSION,
      From: "+61123456789",
      Body: "/status",
      CommandTurn: createCommandTurnContext("native", {
        authorized: true,
        commandName: "status",
        body: "/status",
      }),
    });

    await beforeDeliver({ text: "status reply" }, { kind: "final" } as never);
    expect(seen[0]?.provenanceExempt).toBe(true);
  });
});

describe("mandatory message_sending provenance enforcement fails closed", () => {
  it("denies a WhatsApp direct reply when the provenance hook throws", async () => {
    installMessageSendingHook(() => {
      throw new Error("provenance hook exploded");
    });
    const result = await applyMessageSendingHook(directWhatsAppHookParams());
    expect(result.cancelled).toBe(true);
    expect(result.cancelReason).toBe("provenance_enforcement_failed");
  });

  it("denies a WhatsApp direct reply when the provenance hook times out", async () => {
    installMessageSendingHook(
      () =>
        new Promise<never>(() => {
          // Never settles; the runner's bounded timeout must deny delivery.
        }),
      5,
    );
    const result = await applyMessageSendingHook(directWhatsAppHookParams());
    expect(result.cancelled).toBe(true);
    expect(result.cancelReason).toBe("provenance_enforcement_failed");
  });

  it("denies a WhatsApp direct reply on a malformed mandatory hook result", async () => {
    installMessageSendingHook(() => ({ cancel: false }));
    const result = await applyMessageSendingHook(directWhatsAppHookParams());
    expect(result.cancelled).toBe(true);
    expect(result.cancelReason).toBe("provenance_enforcement_failed");
  });

  it("allows a WhatsApp direct reply when the hook returns a valid content decision", async () => {
    installMessageSendingHook(() => ({ content: "owner reply with provenance" }));
    const result = await applyMessageSendingHook(directWhatsAppHookParams());
    expect(result.cancelled).toBe(false);
    expect(result.payload.text).toBe("owner reply with provenance");
  });

  it("keeps trusted exempt command/system replies fail-open", async () => {
    installMessageSendingHook(() => {
      throw new Error("non-provenance hook exploded");
    });
    const result = await applyMessageSendingHook(
      directWhatsAppHookParams({ provenanceExempt: true }),
    );
    expect(result.cancelled).toBe(false);
  });

  it("keeps unrelated non-WhatsApp paths fail-open", async () => {
    installMessageSendingHook(() => {
      throw new Error("telegram hook exploded");
    });
    const result = await applyMessageSendingHook(
      directWhatsAppHookParams({
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
    expect(result.cancelled).toBe(false);
  });
});

describe("mandatory provenance fails closed when the hook is absent", () => {
  it("denies a mandatory WhatsApp DM when the hook runner is missing", async () => {
    resetGlobalHookRunner();
    const result = await applyMessageSendingHook({
      hookRunner: null,
      enabled: false,
      payload: { text: "owner reply" },
      payloadSummary: { text: "owner reply" },
      to: "+61123456789",
      channel: "whatsapp",
      sessionKey: WHATSAPP_DIRECT_SESSION,
    });
    expect(result.cancelled).toBe(true);
    expect(result.cancelReason).toBe("provenance_enforcement_unavailable");
  });

  it("denies a mandatory WhatsApp DM when the runner has no message_sending handler", async () => {
    installEmptyHookRunner();
    const result = await applyMessageSendingHook(directWhatsAppHookParams());
    expect(result.cancelled).toBe(true);
    expect(result.cancelReason).toBe("provenance_enforcement_unavailable");
  });

  it("allows a trusted provenance-exempt command reply with no hook", async () => {
    resetGlobalHookRunner();
    const result = await applyMessageSendingHook(
      directWhatsAppHookParams({ hookRunner: null, enabled: false, provenanceExempt: true }),
    );
    expect(result.cancelled).toBe(false);
  });

  it("leaves non-WhatsApp paths unchanged with no hook", async () => {
    resetGlobalHookRunner();
    const result = await applyMessageSendingHook(
      directWhatsAppHookParams({
        hookRunner: null,
        enabled: false,
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
    expect(result.cancelled).toBe(false);
  });

  it("legacy boundary denies a mandatory WhatsApp DM when no message_sending hook exists", async () => {
    resetGlobalHookRunner();
    const beforeDeliver = buildLegacyInboundMessageSendingBeforeDeliver({
      Surface: "whatsapp",
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      SessionKey: WHATSAPP_DIRECT_SESSION,
      From: "+61123456789",
      Body: "please check the server",
      CommandTurn: createCommandTurnContext("message", {
        authorized: false,
        body: "please check the server",
      }),
    });
    expect(beforeDeliver).toBeTypeOf("function");
    const result = await beforeDeliver?.({ text: "owner reply" }, { kind: "final" } as never);
    expect(result).toBeNull();
  });

  it("legacy boundary stays absent for non-required channels with no hook", () => {
    resetGlobalHookRunner();
    const beforeDeliver = buildLegacyInboundMessageSendingBeforeDeliver({
      Surface: "telegram",
      Provider: "telegram",
      OriginatingChannel: "telegram",
      SessionKey: "agent:main:telegram:direct:123",
      From: "123",
      Body: "hello",
      CommandTurn: createCommandTurnContext("message", {
        authorized: false,
        body: "hello",
      }),
    });
    expect(beforeDeliver).toBeUndefined();
  });

  it("projected boundary denies a mandatory WhatsApp DM when no message_sending hook exists", async () => {
    resetGlobalHookRunner();
    const beforeDeliver = buildProjectedInboundMessageSendingBeforeDeliver({
      Surface: "whatsapp",
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      SessionKey: WHATSAPP_DIRECT_SESSION,
      From: "+61123456789",
      Body: "please check the server",
      CommandTurn: createCommandTurnContext("message", {
        authorized: false,
        body: "please check the server",
      }),
    });
    const result = await beforeDeliver({ text: "owner reply" }, { kind: "final" } as never);
    expect(result).toBeNull();
  });

  it("durable boundary (applyMessageSendingHook) denies a mandatory WhatsApp DM with no hook", async () => {
    resetGlobalHookRunner();
    const result = await applyMessageSendingHook({
      hookRunner: null,
      enabled: false,
      payload: { text: "owner reply" },
      payloadSummary: { text: "owner reply" },
      to: "+61123456789",
      channel: "whatsapp",
      sessionKey: WHATSAPP_DIRECT_SESSION,
    });
    expect(result.cancelled).toBe(true);
  });
});

describe("Blocker 1: WhatsApp DM provenance requirement is dmScope-independent", () => {
  it("treats agent:main:main as a mandatory WhatsApp direct reply", async () => {
    installMessageSendingHook(() => {
      throw new Error("boom");
    });
    const result = await applyMessageSendingHook(mainScopeWhatsAppHookParams());
    expect(result.cancelled).toBe(true);
  });

  it("fails closed on missing hook for per-channel-peer and per-account-channel-peer keys", async () => {
    resetGlobalHookRunner();
    for (const sessionKey of [
      "agent:main:whatsapp:direct:+61123456789",
      "agent:main:whatsapp:default:direct:+61123456789",
    ]) {
      const result = await applyMessageSendingHook(
        mainScopeWhatsAppHookParams({ hookRunner: null, enabled: false, sessionKey }),
      );
      expect(result.cancelled).toBe(true);
    }
  });

  it("denies a malformed mandatory result under agent:main:main", async () => {
    installMessageSendingHook(() => ({ cancel: false }));
    const result = await applyMessageSendingHook(mainScopeWhatsAppHookParams());
    expect(result.cancelled).toBe(true);
  });

  it("allows a valid content decision under agent:main:main", async () => {
    installMessageSendingHook(() => ({ content: "ok" }));
    const result = await applyMessageSendingHook(mainScopeWhatsAppHookParams());
    expect(result.cancelled).toBe(false);
  });

  it("allows a trusted exempt command with no hook under agent:main:main", async () => {
    resetGlobalHookRunner();
    const result = await applyMessageSendingHook(
      mainScopeWhatsAppHookParams({
        hookRunner: null,
        enabled: false,
        provenanceExempt: true,
      }),
    );
    expect(result.cancelled).toBe(false);
  });

  it("does not classify a Telegram main-scope session as WhatsApp", async () => {
    resetGlobalHookRunner();
    const result = await applyMessageSendingHook(
      mainScopeWhatsAppHookParams({
        hookRunner: null,
        enabled: false,
        channel: "telegram",
        sessionKey: "agent:main:main",
      }),
    );
    expect(result.cancelled).toBe(false);
  });

  it("legacy boundary denies main-scope WhatsApp DM when no hook exists", async () => {
    resetGlobalHookRunner();
    const beforeDeliver = buildLegacyInboundMessageSendingBeforeDeliver({
      Surface: "whatsapp",
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      SessionKey: "agent:main:main",
      From: "+61123456789",
      Body: "please check the server",
      CommandTurn: createCommandTurnContext("message", {
        authorized: false,
        body: "please check the server",
      }),
    });
    expect(beforeDeliver).toBeTypeOf("function");
    const result = await beforeDeliver?.({ text: "owner reply" }, { kind: "final" } as never);
    expect(result).toBeNull();
  });
});
