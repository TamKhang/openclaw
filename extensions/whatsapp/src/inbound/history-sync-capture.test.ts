import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { WAMessage } from "baileys";
import {
  attachWhatsAppPassiveHistorySyncCapture,
  WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT,
} from "./history-sync-capture.js";

function message(index: number, overrides: Partial<WAMessage> = {}): WAMessage {
  return {
    key: {
      remoteJid: "120363400000000001@g.us",
      id: `history-${index}`,
      participant: `1555000000${index}@s.whatsapp.net`,
    },
    messageTimestamp: 1_722_470_400 + index,
    message: { conversation: `Synthetic history message ${index}` },
    ...overrides,
  } as WAMessage;
}

describe("attachWhatsAppPassiveHistorySyncCapture", () => {
  it("is default-off while still detaching its passive listener", () => {
    const events = new EventEmitter();
    const onHistoryMessage = vi.fn();
    const detach = attachWhatsAppPassiveHistorySyncCapture({
      events,
      accountId: "test-account",
      isEnabled: () => false,
      groupSubjectFor: () => "Cached group only",
      onHistoryMessage,
    });

    events.emit(WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT, { messages: [message(1)] });
    expect(onHistoryMessage).not.toHaveBeenCalled();
    detach();
    events.emit(WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT, { messages: [message(2)] });
    expect(onHistoryMessage).not.toHaveBeenCalled();
  });

  it("normalizes synthetic group history with marked provenance", () => {
    const events = new EventEmitter();
    const onHistoryMessage = vi.fn();
    attachWhatsAppPassiveHistorySyncCapture({
      events,
      accountId: "test-account",
      isEnabled: () => true,
      groupSubjectFor: () => "Cached group only",
      onHistoryMessage,
    });

    events.emit(WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT, {
      messages: [message(1), message(2), message(3), message(4)],
    });

    expect(onHistoryMessage).toHaveBeenCalledTimes(4);
    expect(onHistoryMessage).toHaveBeenLastCalledWith({
      event: expect.objectContaining({
        from: "120363400000000001@g.us",
        messageId: "history-4",
        metadata: {
          ingestionMode: "historical_backfill",
          historicalSource: "baileys_history_sync",
          groupSubject: "Cached group only",
        },
      }),
      context: expect.objectContaining({
        channelId: "whatsapp",
        accountId: "test-account",
        conversationId: "120363400000000001@g.us",
      }),
    });
  });

  it("rejects direct, broadcast, malformed, and unsupported history messages", () => {
    const events = new EventEmitter();
    const onHistoryMessage = vi.fn();
    attachWhatsAppPassiveHistorySyncCapture({
      events,
      accountId: "test-account",
      isEnabled: () => true,
      groupSubjectFor: () => "must not matter",
      onHistoryMessage,
    });

    events.emit(WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT, {
      messages: [
        message(1, { key: { remoteJid: "15550000001@s.whatsapp.net", id: "direct" } }),
        message(2, { key: { remoteJid: "status@broadcast", id: "broadcast" } }),
        message(3, { key: { remoteJid: "120363400000000001@g.us" } }),
        message(4, { message: { imageMessage: {} } }),
      ],
    });

    expect(onHistoryMessage).not.toHaveBeenCalled();
  });

  it("exposes only passive normalization and listener attachment", () => {
    expect(WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT).toBe("messaging-history.set");
    expect(Object.getOwnPropertyNames(attachWhatsAppPassiveHistorySyncCapture)).toEqual(
      expect.arrayContaining(["length", "name", "prototype"]),
    );
  });
});
