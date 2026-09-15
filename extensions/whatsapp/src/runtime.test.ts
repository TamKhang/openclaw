import type { PluginRuntime } from "openclaw/plugin-sdk/core";
// Whatsapp tests cover runtime injection across plugin registry reloads.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOptionalWhatsAppChannelRuntime,
  getOptionalWhatsAppOutboundAuthorizationRegistrar,
  getWhatsAppChannelRuntime,
  getWhatsAppOutboundAuthorizationRegistrar,
  getWhatsAppRuntime,
  resetWhatsAppOutboundAuthorizationRegistrarForTests,
  setWhatsAppOutboundAuthorizationRegistrar,
  setWhatsAppRuntime,
  type WhatsAppOutboundAuthorizationRegistrar,
} from "./runtime.js";

function fakeRegistrar(): WhatsAppOutboundAuthorizationRegistrar {
  return vi.fn() as unknown as WhatsAppOutboundAuthorizationRegistrar;
}

afterEach(() => {
  resetWhatsAppOutboundAuthorizationRegistrarForTests();
});

describe("WhatsApp runtime", () => {
  it("preserves the channel context owner when the injected runtime changes", () => {
    const originalChannelRuntime = getOptionalWhatsAppChannelRuntime();
    const first = { channel: { runtimeContexts: { id: "first" } } } as unknown as PluginRuntime;
    const second = { channel: { runtimeContexts: { id: "second" } } } as unknown as PluginRuntime;

    setWhatsAppRuntime(first);
    setWhatsAppRuntime(second);

    expect(getWhatsAppRuntime()).toBe(second);
    expect(getWhatsAppChannelRuntime()).toBe(originalChannelRuntime ?? first.channel);
  });
});

describe("WhatsApp outbound authorization registrar injection", () => {
  it("fails closed before trusted host initialization", () => {
    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).toBeNull();
    expect(() => getWhatsAppOutboundAuthorizationRegistrar()).toThrow(/registrar not initialized/u);
  });

  it("supplies the registrar from trusted host initialization", () => {
    const registrar = fakeRegistrar();
    setWhatsAppOutboundAuthorizationRegistrar(registrar);
    expect(getWhatsAppOutboundAuthorizationRegistrar()).toBe(registrar);
    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).toBe(registrar);
  });

  it("never swaps in an untrusted registrar after first initialization", () => {
    const first = fakeRegistrar();
    const second = fakeRegistrar();
    setWhatsAppOutboundAuthorizationRegistrar(first);
    setWhatsAppOutboundAuthorizationRegistrar(second);
    expect(getWhatsAppOutboundAuthorizationRegistrar()).toBe(first);
    expect(getWhatsAppOutboundAuthorizationRegistrar()).not.toBe(second);
  });

  it("isolates the registrar slot for tests", () => {
    setWhatsAppOutboundAuthorizationRegistrar(fakeRegistrar());
    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).not.toBeNull();
    resetWhatsAppOutboundAuthorizationRegistrarForTests();
    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).toBeNull();
  });
});
