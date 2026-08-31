import { getPrimaryIdentityId, getSenderIdentity } from "../../identity.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { buildWhatsAppInboundContext } from "./inbound-dispatch.js";
import {
  emitWhatsAppMessageReceivedHooks,
  shouldEmitWhatsAppMessageReceivedHooks,
} from "./process-message.js";
import type { LoadConfigFn, resolveAgentRoute } from "./runtime-api.js";

/** Emit the opted-in WhatsApp `message_received` observation hook before group
 * mention/activation gating runs. This path is observation-only: it does not
 * start a turn, send any reaction/ack, or produce outbound WhatsApp traffic. */
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
  const ctx = await buildWhatsAppInboundContext({
    combinedBody: params.msg.payload.body,
    rawBody: params.msg.payload.body,
    msg: params.msg,
    route: params.route,
    sender: {
      id: getPrimaryIdentityId(sender) ?? undefined,
      name: sender.name ?? undefined,
      e164: sender.e164 ?? undefined,
    },
    suppressMessageReceivedHooks: true,
  });

  emitWhatsAppMessageReceivedHooks({
    ctx,
    sessionKey: params.sessionKey,
  });
}
