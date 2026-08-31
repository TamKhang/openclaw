// WhatsApp tests cover observation for groups rejected by reply admission.
import { beforeEach, describe, expect, it, vi } from "vitest";

const shouldEmitMock = vi.hoisted(() => vi.fn());
const emitHooksMock = vi.hoisted(() => vi.fn());

vi.mock("../auto-reply/monitor/process-message.js", () => ({
  shouldEmitWhatsAppMessageReceivedHooks: (...args: unknown[]) => shouldEmitMock(...args),
  emitWhatsAppMessageReceivedHooks: (...args: unknown[]) => emitHooksMock(...args),
}));

import { emitBlockedWhatsAppGroupObservation } from "./observation.js";

describe("emitBlockedWhatsAppGroupObservation", () => {
  beforeEach(() => {
    shouldEmitMock.mockReset();
    emitHooksMock.mockReset();
  });

  it("does not emit when WhatsApp message_received hooks are not opted in", () => {
    shouldEmitMock.mockReturnValue(false);

    emitBlockedWhatsAppGroupObservation({
      cfg: {} as never,
      accountId: "default",
      selfE164: "+15550000001",
      body: "ordinary group message",
      id: "message-1",
      remoteJid: "1203630@g.us",
      participantJid: "sender@s.whatsapp.net",
      senderE164: "+15550002222",
      groupSubject: "Unconfigured Group",
      messageTimestampMs: 1_710_000_000_000,
      pushName: "Alice",
    });

    expect(emitHooksMock).not.toHaveBeenCalled();
  });

  it("emits an observation-only hook for a blocked group message", () => {
    shouldEmitMock.mockReturnValue(true);

    emitBlockedWhatsAppGroupObservation({
      cfg: {} as never,
      accountId: "default",
      selfE164: "+15550000001",
      body: "ordinary group message",
      id: "message-1",
      remoteJid: "1203630@g.us",
      participantJid: "sender@s.whatsapp.net",
      senderE164: "+15550002222",
      groupSubject: "Unconfigured Group",
      messageTimestampMs: 1_710_000_000_000,
      pushName: "Alice",
    });

    expect(emitHooksMock).toHaveBeenCalledTimes(1);
    expect(emitHooksMock.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:observation:whatsapp:group:1203630@g.us",
    });
    expect(emitHooksMock.mock.calls[0]?.[0].ctx).toMatchObject({
      From: "1203630@g.us",
      To: "+15550000001",
      RawBody: "ordinary group message",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "1203630@g.us",
      GroupSubject: "Unconfigured Group",
      GroupChannel: "1203630@g.us",
      AccountId: "default",
      SenderId: "sender@s.whatsapp.net",
      SenderName: "Alice",
      SenderE164: "+15550002222",
    });
  });
});
