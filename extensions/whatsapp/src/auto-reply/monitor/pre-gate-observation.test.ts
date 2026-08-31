// WhatsApp tests cover the deterministic pre-gating observation emitter.
import { beforeEach, describe, expect, it, vi } from "vitest";

const shouldEmitMock = vi.hoisted(() => vi.fn());
const emitHooksMock = vi.hoisted(() => vi.fn());
const buildContextMock = vi.hoisted(() => vi.fn());

vi.mock("./process-message.js", () => ({
  shouldEmitWhatsAppMessageReceivedHooks: (...args: unknown[]) => shouldEmitMock(...args),
  emitWhatsAppMessageReceivedHooks: (...args: unknown[]) => emitHooksMock(...args),
}));

vi.mock("./inbound-dispatch.js", () => ({
  buildWhatsAppInboundContext: (...args: unknown[]) => buildContextMock(...args),
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => "sender-id",
  getSenderIdentity: () => ({ name: "Alice", e164: "+15550002222" }),
}));

import { emitPreGateWhatsAppGroupObservation } from "./pre-gate-observation.js";

const msg = { payload: { body: "hello group" } } as never;
const route = {
  agentId: "main",
  accountId: "default",
  sessionKey: "agent:main:whatsapp:group",
} as never;

describe("emitPreGateWhatsAppGroupObservation", () => {
  beforeEach(() => {
    shouldEmitMock.mockReset();
    emitHooksMock.mockReset();
    buildContextMock.mockReset();
  });

  it("emits nothing when WhatsApp message_received hooks are not opted in", async () => {
    shouldEmitMock.mockReturnValue(false);

    await emitPreGateWhatsAppGroupObservation({
      cfg: {} as never,
      msg,
      route,
      sessionKey: "agent:main:whatsapp:group",
    });

    expect(buildContextMock).not.toHaveBeenCalled();
    expect(emitHooksMock).not.toHaveBeenCalled();
  });

  it("builds a sanitized group context and emits the observation hook exactly once", async () => {
    shouldEmitMock.mockReturnValue(true);
    const ctx = { GroupSubject: "3C Castle Hill" };
    buildContextMock.mockResolvedValue(ctx);

    await emitPreGateWhatsAppGroupObservation({
      cfg: {} as never,
      msg,
      route,
      sessionKey: "agent:main:whatsapp:group",
    });

    expect(buildContextMock).toHaveBeenCalledTimes(1);
    expect(buildContextMock.mock.calls[0]?.[0]).toMatchObject({
      combinedBody: "hello group",
      rawBody: "hello group",
      msg,
      route,
      sender: {
        id: "sender-id",
        name: "Alice",
        e164: "+15550002222",
      },
      suppressMessageReceivedHooks: true,
    });
    expect(emitHooksMock).toHaveBeenCalledTimes(1);
    expect(emitHooksMock.mock.calls[0]?.[0]).toEqual({
      ctx,
      sessionKey: "agent:main:whatsapp:group",
    });
  });
});
