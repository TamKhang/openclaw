import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  emitWhatsAppMessageReceivedHooks,
  shouldEmitWhatsAppMessageReceivedHooks,
} from "../auto-reply/monitor/process-message.js";
import type { LoadConfigFn } from "../auto-reply/monitor/runtime-api.js";

/** Emit the WhatsApp observation hook for a group inbound message that was
 * rejected by reply/agent admission. This is read-only: it never marks the
 * message as read, sends pairing/receipt traffic, or creates a turn. */
export function emitBlockedWhatsAppGroupObservation(params: {
  cfg: ReturnType<LoadConfigFn>;
  accountId: string;
  selfE164: string | null;
  body: string;
  id?: string;
  remoteJid: string;
  participantJid?: string;
  senderE164: string | null;
  groupSubject?: string;
  messageTimestampMs?: number;
  pushName?: string;
}): void {
  if (
    !shouldEmitWhatsAppMessageReceivedHooks({
      cfg: params.cfg,
      accountId: params.accountId,
    })
  ) {
    return;
  }

  const sessionKey = `agent:observation:whatsapp:group:${params.remoteJid}`;
  const ctx = {
    From: params.remoteJid,
    To: params.selfE164 ?? "me",
    Body: params.body,
    RawBody: params.body,
    BodyForAgent: params.body,
    BodyForCommands: params.body,
    OriginatingChannel: "whatsapp",
    Surface: "whatsapp",
    Provider: "whatsapp",
    OriginatingTo: params.remoteJid,
    GroupSubject: params.groupSubject,
    GroupChannel: params.remoteJid,
    Timestamp: params.messageTimestampMs,
    MessageSid: params.id,
    MessageSidFull: params.id,
    AccountId: params.accountId,
    SessionKey: sessionKey,
    SenderId: params.participantJid ?? params.senderE164 ?? undefined,
    SenderName: params.pushName,
    SenderE164: params.senderE164 ?? undefined,
  } as FinalizedMsgContext;

  emitWhatsAppMessageReceivedHooks({
    ctx,
    sessionKey,
  });
}
