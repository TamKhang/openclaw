import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runChannelInboundEventMock = vi.hoisted(() => vi.fn());
const fireAndForgetBoundedHookMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-inbound", () => ({
  runChannelInboundEvent: (...args: unknown[]) => runChannelInboundEventMock(...args),
}));

vi.mock("openclaw/plugin-sdk/hook-runtime", () => ({
  createInternalHookEvent: () => ({}),
  deriveInboundMessageHookContext: (ctx: unknown) => ctx,
  fireAndForgetBoundedHook: (...args: unknown[]) => fireAndForgetBoundedHookMock(...args),
  toInternalMessageReceivedContext: (ctx: unknown) => ctx,
  toPluginMessageContext: (ctx: unknown) => ctx,
  toPluginMessageReceivedEvent: (ctx: unknown) => ctx,
  triggerInternalHook: () => {},
}));

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({ hasHooks: () => false }),
}));

vi.mock("../identity.js", () => ({
  getPrimaryIdentityId: () => "sender-id",
  getSenderIdentity: () => ({ name: "Alice", e164: "+15550000002" }),
}));

import { emitPreGateWhatsAppGroupObservation } from "../auto-reply/monitor/pre-gate-observation.js";
import {
  attachWhatsAppPassiveHistorySyncCapture,
  WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT,
} from "./history-sync-capture.js";
import { emitBlockedWhatsAppGroupObservation } from "./observation.js";

const preGateMsg = {
  admission: { conversation: { id: "group@g.us" } },
  payload: { body: "ordinary group message" },
  platform: { recipientJid: "+15550000001" },
  event: { id: "message-1", timestamp: 1_700_000_000 },
  group: { subject: "Group" },
} as never;

const route = { accountId: "default" } as never;

describe("passive WhatsApp observation model safety", () => {
  beforeEach(() => {
    runChannelInboundEventMock.mockReset();
    fireAndForgetBoundedHookMock.mockReset();
  });

  it("pre-gate observation never reaches channel inbound model execution", async () => {
    await emitPreGateWhatsAppGroupObservation({
      cfg: {
        channels: { whatsapp: { pluginHooks: { messageReceived: true } } },
      } as never,
      msg: preGateMsg,
      route,
      sessionKey: "agent:main:whatsapp:group",
    });
    expect(runChannelInboundEventMock).not.toHaveBeenCalled();
  });

  it("blocked observation never reaches channel inbound model execution", () => {
    emitBlockedWhatsAppGroupObservation({
      cfg: {
        channels: {
          whatsapp: {
            pluginHooks: { messageReceived: true },
          },
        },
      } as never,
      accountId: "default",
      selfE164: "+15550000001",
      body: "ordinary group message",
      id: "message-1",
      remoteJid: "group@g.us",
      senderE164: "+15550000002",
    });
    expect(runChannelInboundEventMock).not.toHaveBeenCalled();
  });

  it("passive history sync never reaches channel inbound model execution", () => {
    const events = new EventEmitter();
    const onHistoryMessage = vi.fn();
    attachWhatsAppPassiveHistorySyncCapture({
      events,
      accountId: "default",
      isEnabled: () => true,
      groupSubjectFor: () => undefined,
      onHistoryMessage,
    });
    events.emit(WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT, {
      messages: [
        {
          key: {
            remoteJid: "group@g.us",
            id: "history-1",
            participant: "sender@s.whatsapp.net",
          },
          messageTimestamp: 1_700_000_000,
          message: { conversation: "historical group message" },
        },
      ],
    });
    expect(onHistoryMessage).toHaveBeenCalledTimes(1);
    expect(runChannelInboundEventMock).not.toHaveBeenCalled();
  });
});
