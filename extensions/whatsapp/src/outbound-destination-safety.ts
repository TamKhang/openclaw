export type WhatsAppDestinationKind = "direct" | "group" | "newsletter" | "unknown";

export function classifyWhatsAppDestination(resolvedDestination: string): WhatsAppDestinationKind {
  const jid = resolvedDestination.trim().toLowerCase();
  if (!jid) {
    return "unknown";
  }
  if (jid.endsWith("@g.us")) {
    return "group";
  }
  if (jid.endsWith("@newsletter")) {
    return "newsletter";
  }
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) {
    return "direct";
  }
  return "unknown";
}

export class WhatsAppGroupOutboundDeniedError extends Error {
  readonly code = "WHATSAPP_GROUP_OUTBOUND_DENIED";
  readonly deliveryState = "not_sent";

  constructor(readonly destination: string) {
    super("WhatsApp group outbound is permanently denied");
    this.name = "WhatsAppGroupOutboundDeniedError";
  }
}

export function assertWhatsAppOutboundAllowed(resolvedDestination: string): void {
  if (classifyWhatsAppDestination(resolvedDestination) === "group") {
    throw new WhatsAppGroupOutboundDeniedError(resolvedDestination);
  }
}
