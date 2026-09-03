import { beforeEach, describe, expect, it, vi } from "vitest";

const shouldEmitMock = vi.hoisted(() => vi.fn());
const emitHooksMock = vi.hoisted(() => vi.fn());

vi.mock("../../inbound/observation.js", () => ({
  shouldEmitWhatsAppMessageReceivedHooks: (...args: unknown[]) => shouldEmitMock(...args),
  emitWhatsAppMessageReceivedHooks: (...args: unknown[]) => emitHooksMock(...args),
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => "sender-id",
  getSenderIdentity: () => ({ name: "Alice", e164: "+15550000002" }),
}));

import { emitPreGateWhatsAppGroupObservation } from "./pre-gate-observation.js";

const msg = {
  admission: { conversation: { id: "group@g.us" } },
  payload: { body: "hello group" },
  platform: { recipientJid: "+15550000001" },
  event: { id: "message-1", timestamp: 1_700_000_000 },
  group: { subject: "Group" },
} as never;

const route = { accountId: "default" } as never;

describe("emitPreGateWhatsAppGroupObservation", () => {
  beforeEach(() => {
    shouldEmitMock.mockReset();
    emitHooksMock.mockReset();
  });

  it("emits nothing when hooks are not opted in", async () => {
    shouldEmitMock.mockReturnValue(false);
    await emitPreGateWhatsAppGroupObservation({
      cfg: {} as never,
      msg,
      route,
      sessionKey: "agent:main:whatsapp:group",
    });
    expect(emitHooksMock).not.toHaveBeenCalled();
  });

  it("emits a pre-gate observation hook", async () => {
    shouldEmitMock.mockReturnValue(true);
    await emitPreGateWhatsAppGroupObservation({
      cfg: {} as never,
      msg,
      route,
      sessionKey: "agent:main:whatsapp:group",
    });
    expect(emitHooksMock).toHaveBeenCalledTimes(1);
    expect(emitHooksMock.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:main:whatsapp:group",
    });
  });
});
