// Whatsapp plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { WhatsAppOutboundAuthorization } from "openclaw/plugin-sdk/whatsapp-outbound-authorization";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "whatsapp",
  errorMessage: "WhatsApp runtime not initialized",
});
const channelRuntimeStore = createPluginRuntimeStore<PluginRuntime["channel"]>({
  key: "plugin-runtime:whatsapp:channel-context-owner",
  errorMessage: "WhatsApp channel runtime not initialized",
});

/**
 * Trusted host-owned authorization registrar injected during bundled channel
 * initialization. The host supplies the core singleton registrar through the
 * entry-contract runtime-dependency mechanism; the externalized package never
 * imports the private-local-only registration subpath.
 */
export type WhatsAppOutboundAuthorizationRegistrar = (
  permit: WhatsAppOutboundAuthorization,
) => void;

// Private module-lexical slot. Unlike createPluginRuntimeStore's global named
// slots, this binding is not discoverable through the public runtime-store
// registry, so another plugin cannot read, clear, replace, or invoke it. The
// compiled WhatsApp runtime chunks all import this one module, so the setter
// (runtime-setter-api) and the consumer (monitor) share a single binding after
// compilation.
let outboundAuthorizationRegistrar: WhatsAppOutboundAuthorizationRegistrar | null = null;

/** First trusted host injection wins; later calls cannot swap the registrar. */
function setWhatsAppOutboundAuthorizationRegistrar(
  next: WhatsAppOutboundAuthorizationRegistrar,
): void {
  if (outboundAuthorizationRegistrar === null) {
    outboundAuthorizationRegistrar = next;
  }
}

function getWhatsAppOutboundAuthorizationRegistrar(): WhatsAppOutboundAuthorizationRegistrar {
  if (outboundAuthorizationRegistrar === null) {
    throw new Error("WhatsApp outbound authorization registrar not initialized");
  }
  return outboundAuthorizationRegistrar;
}

function getOptionalWhatsAppOutboundAuthorizationRegistrar(): WhatsAppOutboundAuthorizationRegistrar | null {
  return outboundAuthorizationRegistrar;
}

/** Test-only reset; tree-shaken from compiled production entry exports. */
function resetWhatsAppOutboundAuthorizationRegistrarForTests(): void {
  outboundAuthorizationRegistrar = null;
}

/** Injects current helpers while preserving the process-lifetime channel context owner. */
function setWhatsAppRuntime(next: PluginRuntime): void {
  // Plugin registry reloads create fresh runtime objects. Live connection leases must remain
  // readable by outbound sends until their account task explicitly disposes them.
  if (!channelRuntimeStore.tryGetRuntime()) {
    channelRuntimeStore.setRuntime(next.channel);
  }
  runtimeStore.setRuntime(next);
}

const getWhatsAppRuntime = runtimeStore.getRuntime;
const getOptionalWhatsAppRuntime = runtimeStore.tryGetRuntime;
const getWhatsAppChannelRuntime = channelRuntimeStore.getRuntime;
const getOptionalWhatsAppChannelRuntime = channelRuntimeStore.tryGetRuntime;

export {
  getOptionalWhatsAppChannelRuntime,
  getOptionalWhatsAppOutboundAuthorizationRegistrar,
  getOptionalWhatsAppRuntime,
  getWhatsAppChannelRuntime,
  getWhatsAppOutboundAuthorizationRegistrar,
  getWhatsAppRuntime,
  resetWhatsAppOutboundAuthorizationRegistrarForTests,
  setWhatsAppOutboundAuthorizationRegistrar,
  setWhatsAppRuntime,
};
