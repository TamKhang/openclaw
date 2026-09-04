// WhatsApp pre-gating observation emits the opted-in `message_received` hook
// before group mention/activation gating. It is observation-only and never
// starts a turn, sends an ack/reaction, or produces outbound WhatsApp traffic.
import { getPrimaryIdentityId, getSenderIdentity } from "../../identity.js";
import {
  emitWhatsAppMessageReceivedHooks,
  shouldEmitWhatsAppMessageReceivedHooks,
} from "../../inbound/observation.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import type { LoadConfigFn, resolveAgentRoute } from "./runtime-api.js";

export async function emitPreGateWhatsAppGroupObservation(params: {
  cfg: ReturnType<LoadConfigFn>;
  msg: AdmittedWebInboundMessage;
  route: ReturnType<typeof resolveAgentRoute>;
  sessionKey: string;
}): Promise<void> {
  if (
    !shouldEmitWhatsAppMessageReceivedHooks({
      cfg: params.cfg,
      accountId: params.route.accountId,
    })
  ) {
    return;
  }

  const sender = getSenderIdentity(params.msg);
  const conversationId = params.msg.admission.conversation.id;
  const ctx = {
    From: conversationId,
    To: params.msg.platform.recipientJid,
    Body: params.msg.payload.body,
    RawBody: params.msg.payload.body,
    BodyForAgent: params.msg.payload.body,
    BodyForCommands: params.msg.payload.body,
    OriginatingChannel: "whatsapp",
    Surface: "whatsapp",
    Provider: "whatsapp",
    OriginatingTo: conversationId,
    GroupSubject: params.msg.group?.subject,
    GroupChannel: conversationId,
    Timestamp: params.msg.event.timestamp,
    MessageSid: params.msg.event.id,
    MessageSidFull: params.msg.event.id,
    AccountId: params.route.accountId,
    SessionKey: params.sessionKey,
    SenderId: getPrimaryIdentityId(sender) ?? undefined,
    SenderName: sender.name ?? undefined,
    SenderE164: sender.e164 ?? undefined,
    CommandAuthorized: false,
  };

  emitWhatsAppMessageReceivedHooks({
    ctx,
    sessionKey: params.sessionKey,
  });
}
