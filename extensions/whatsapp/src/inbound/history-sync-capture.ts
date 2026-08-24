import type { WAMessage } from "baileys";
import { extractText } from "./extract.js";
import { isJidGroup } from "./runtime-api.js";

export const WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT = "messaging-history.set";

export type WhatsAppPassiveHistoryHookEvent = {
  from: string;
  content: string;
  timestamp: number;
  messageId: string;
  senderId?: string;
  metadata: {
    ingestionMode: "historical_backfill";
    historicalSource: "baileys_history_sync";
    groupSubject?: string;
  };
};

export type WhatsAppPassiveHistoryHookContext = {
  channelId: "whatsapp";
  accountId: string;
  conversationId: string;
  messageId: string;
  senderId?: string;
};

export type WhatsAppPassiveHistoryMessage = {
  event: WhatsAppPassiveHistoryHookEvent;
  context: WhatsAppPassiveHistoryHookContext;
};

type HistorySyncSetPayload = {
  messages?: WAMessage[];
};

type PassiveHistoryEventEmitter = {
  on(event: string, listener: (payload: unknown) => void): void;
  off?(event: string, listener: (payload: unknown) => void): void;
  removeListener?(event: string, listener: (payload: unknown) => void): void;
};

function timestampSeconds(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function normalizeWhatsAppPassiveHistoryMessage(params: {
  accountId: string;
  message: WAMessage;
  groupSubject?: string;
}): WhatsAppPassiveHistoryMessage | undefined {
  const groupId = params.message.key?.remoteJid;
  const messageId = params.message.key?.id;
  const content = extractText(params.message.message ?? undefined);
  const timestamp = timestampSeconds(params.message.messageTimestamp);
  if (!groupId || !isJidGroup(groupId) || !messageId || !content || timestamp === undefined) {
    return undefined;
  }

  const senderId = params.message.key?.participant ?? undefined;
  return {
    event: {
      from: groupId,
      content,
      timestamp,
      messageId,
      ...(senderId === undefined ? {} : { senderId }),
      metadata: {
        ingestionMode: "historical_backfill",
        historicalSource: "baileys_history_sync",
        ...(params.groupSubject === undefined ? {} : { groupSubject: params.groupSubject }),
      },
    },
    context: {
      channelId: "whatsapp",
      accountId: params.accountId,
      conversationId: groupId,
      messageId,
      ...(senderId === undefined ? {} : { senderId }),
    },
  };
}

/**
 * Registers a passive listener only. It neither requests history nor performs
 * socket operations; callers decide whether capture is enabled.
 */
export function attachWhatsAppPassiveHistorySyncCapture(params: {
  events: PassiveHistoryEventEmitter;
  accountId: string;
  isEnabled(): boolean;
  groupSubjectFor(groupId: string): string | undefined;
  onHistoryMessage(message: WhatsAppPassiveHistoryMessage): void;
}): () => void {
  const listener = (payload: unknown) => {
    if (!params.isEnabled() || !payload || typeof payload !== "object") {
      return;
    }
    const messages = (payload as HistorySyncSetPayload).messages;
    if (!Array.isArray(messages)) {
      return;
    }
    for (const message of messages) {
      const groupId = message.key?.remoteJid;
      const normalized = normalizeWhatsAppPassiveHistoryMessage({
        accountId: params.accountId,
        message,
        ...(typeof groupId === "string"
          ? { groupSubject: params.groupSubjectFor(groupId) }
          : {}),
      });
      if (normalized) {
        params.onHistoryMessage(normalized);
      }
    }
  };
  params.events.on(WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT, listener);
  return () => {
    if (params.events.off) {
      params.events.off(WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT, listener);
    } else {
      params.events.removeListener?.(WHATSAPP_PASSIVE_HISTORY_SYNC_EVENT, listener);
    }
  };
}
