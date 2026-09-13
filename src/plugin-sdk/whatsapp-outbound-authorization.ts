// Public SDK seam for trusted WhatsApp outbound authorization.
//
// Bundled channel feature code mints permits from trusted owner state and
// registers them here; the core outbound transport gate claims them
// atomically immediately before transmission. Exposing only registration (and
// never a minting entrypoint for model-visible surfaces) keeps the LLM unable
// to self-authorize.
export {
  claimWhatsAppOutboundAuthorizationForTransport,
  isWhatsAppGroupDestination,
  isWhatsAppAuthorizationRegistered,
  WHATSAPP_GROUP_REPLY_ONCE_CAPABILITY,
  WHATSAPP_GROUP_SEND_ACTION_TYPE,
  WHATSAPP_OUTBOUND_AUTHORIZATION_POLICY_VERSION,
  type WhatsAppOutboundAuthorization,
  type WhatsAppOutboundAuthorizationClass,
  type WhatsAppOutboundTransportClaim,
} from "../infra/outbound/whatsapp-outbound-authorization.js";
