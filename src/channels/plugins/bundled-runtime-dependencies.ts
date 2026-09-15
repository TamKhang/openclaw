// Trusted host runtime-dependency injection for bundled channels.
//
// Bundled channels may declare a narrow runtime dependency (capability +
// setter) in their entry contract. The host resolves only capabilities that
// map to a core-owned singleton and only for the authentic bundled-channel
// entry. Plugin-controlled content (id, kind, capability name, setter) is
// never sufficient: trust is anchored in `origin === "bundled"`, which is
// assigned by trusted loader discovery and cannot be supplied by plugin
// manifest content.
import { registerBrunoHighBrainOverride } from "../../agents/bruno-high-brain.js";
import { registerWhatsAppOutboundAuthorization } from "../../infra/outbound/whatsapp-outbound-authorization.js";
import type { PluginOrigin } from "../../plugins/plugin-origin.types.js";

const WHATSAPP_PLUGIN_ID = "whatsapp";
const WHATSAPP_OUTBOUND_AUTHORIZATION_REGISTRATION_CAPABILITY =
  "whatsapp:outbound-authorization-registration";
const WHATSAPP_HIGH_BRAIN_CLASSIFICATION_REGISTRATION_CAPABILITY =
  "whatsapp:high-brain-classification-registration";
const BUNDLED_CHANNEL_ENTRY_KIND = "bundled-channel-entry";

function includesBundledChannelEntryKind(kind: unknown): boolean {
  return (
    kind === BUNDLED_CHANNEL_ENTRY_KIND ||
    (Array.isArray(kind) && kind.includes(BUNDLED_CHANNEL_ENTRY_KIND))
  );
}

/**
 * Host-owned trust gate for bundled runtime-dependency injection.
 *
 * `origin` is the strongest host-owned bundled provenance marker: discovery
 * assigns it from the physical root the plugin was found in (bundled tree,
 * source overlay, or source checkout), never from manifest/export content. The
 * bundled-channel-entry kind discriminator is a shape requirement layered on
 * top; on its own it is forgeable and therefore not a trust anchor.
 */
export function isTrustedBundledChannelRuntimeDependencyRequest(params: {
  origin: PluginOrigin | undefined;
  kind: unknown;
}): boolean {
  return params.origin === "bundled" && includesBundledChannelEntryKind(params.kind);
}

/** Resolve a trusted bundled-channel runtime dependency, or undefined to fail closed. */
export function resolveBundledChannelRuntimeDependency(params: {
  pluginId: string;
  capability: string;
}): unknown {
  // The privileged registrars resolve only for exact canonical pairs. There is
  // deliberately no generic owner-prefix/key rule here: another bundled
  // channel that declares its own-namespaced capability must never receive a
  // WhatsApp registrar. The High Brain classification registrar is a separate
  // authority from the send authorization registrar; HIGH routing authority
  // never itself authorizes an outbound group message.
  if (params.pluginId === WHATSAPP_PLUGIN_ID) {
    if (params.capability === WHATSAPP_OUTBOUND_AUTHORIZATION_REGISTRATION_CAPABILITY) {
      return registerWhatsAppOutboundAuthorization;
    }
    if (params.capability === WHATSAPP_HIGH_BRAIN_CLASSIFICATION_REGISTRATION_CAPABILITY) {
      return registerBrunoHighBrainOverride;
    }
  }
  return undefined;
}
