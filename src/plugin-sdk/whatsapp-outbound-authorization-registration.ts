// Private, trusted-only WhatsApp outbound authorization registration seam.
//
// This subpath is intentionally private-local-only (not a public package
// export). Only trusted bundled channel feature code may register a freshly
// minted permit. Model/tool execution and ordinary plugins cannot import this
// module through the public SDK surface.
export { registerWhatsAppOutboundAuthorization } from "../infra/outbound/whatsapp-outbound-authorization.js";
