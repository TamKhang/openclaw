// WhatsApp plugin formalizes the canonical inbound event identity.
import { createHash } from "node:crypto";
import { getPrimaryIdentityId, getSenderIdentity } from "../identity.js";
import { requireWhatsAppInboundAdmission } from "./admission.js";
import type { AdmittedWebInboundMessage } from "./types.js";

export const WHATSAPP_INBOUND_SOURCE = "whatsapp";

export type WhatsAppInboundEventIdentity = {
  source: typeof WHATSAPP_INBOUND_SOURCE;
  accountId: string;
  remoteJid: string;
  conversationId: string;
  conversationKind: "direct" | "group";
  messageId: string;
  timestamp?: number;
  senderId?: string;
  quotedMessageId?: string;
  quotedParticipantId?: string;
};

export type WhatsAppInboundEventIdentityResult =
  | { status: "resolved"; identity: WhatsAppInboundEventIdentity; sourceEventId: string }
  | { status: "unresolved"; reason: string };

export function resolveWhatsAppInboundEventIdentity(
  msg: AdmittedWebInboundMessage,
): WhatsAppInboundEventIdentityResult {
  const admission = requireWhatsAppInboundAdmission(msg);
  const messageId = msg.event.id;
  if (!messageId) {
    return { status: "unresolved", reason: "missing_message_id" };
  }
  const senderId = getPrimaryIdentityId(getSenderIdentity(msg)) ?? undefined;
  const identity: WhatsAppInboundEventIdentity = {
    source: WHATSAPP_INBOUND_SOURCE,
    accountId: admission.accountId,
    remoteJid: admission.conversation.id,
    conversationId: admission.conversation.id,
    conversationKind: admission.conversation.kind,
    messageId,
    ...(msg.event.timestamp != null ? { timestamp: msg.event.timestamp } : {}),
    ...(senderId ? { senderId } : {}),
  };
  return {
    status: "resolved",
    identity,
    sourceEventId: hashWhatsAppSourceEventId(identity),
  };
}

export function hashWhatsAppSourceEventId(identity: {
  accountId: string;
  remoteJid: string;
  messageId: string;
}): string {
  return createHash("sha256")
    .update(`${identity.accountId}\n${identity.remoteJid}\n${identity.messageId}`)
    .digest("hex");
}
