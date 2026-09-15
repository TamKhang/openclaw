import type { PluginRuntime } from "openclaw/plugin-sdk/core";
// Whatsapp tests cover runtime injection across plugin registry reloads.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWhatsAppHighBrainClassificationRegistrar as setHighBrainViaSidecar } from "../runtime-setter-api.js";
import {
  getOptionalWhatsAppChannelRuntime,
  getOptionalWhatsAppHighBrainClassificationRegistrar,
  getOptionalWhatsAppOutboundAuthorizationRegistrar,
  getWhatsAppChannelRuntime,
  getWhatsAppHighBrainClassificationRegistrar,
  getWhatsAppOutboundAuthorizationRegistrar,
  getWhatsAppRuntime,
  resetWhatsAppHighBrainClassificationRegistrarForTests,
  resetWhatsAppOutboundAuthorizationRegistrarForTests,
  setWhatsAppHighBrainClassificationRegistrar,
  setWhatsAppOutboundAuthorizationRegistrar,
  setWhatsAppRuntime,
  type WhatsAppHighBrainClassificationRegistrar,
  type WhatsAppOutboundAuthorizationRegistrar,
} from "./runtime.js";

function fakeRegistrar(): WhatsAppOutboundAuthorizationRegistrar {
  return vi.fn() as unknown as WhatsAppOutboundAuthorizationRegistrar;
}

afterEach(() => {
  resetWhatsAppOutboundAuthorizationRegistrarForTests();
  resetWhatsAppHighBrainClassificationRegistrarForTests();
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

describe("WhatsApp High Brain classification registrar injection", () => {
  it("fails closed before trusted host initialization", () => {
    expect(getOptionalWhatsAppHighBrainClassificationRegistrar()).toBeNull();
    expect(() => getWhatsAppHighBrainClassificationRegistrar()).toThrow(
      /High Brain classification registrar not initialized/u,
    );
  });

  it("supplies the registrar from trusted host initialization", () => {
    const registrar = vi.fn() as unknown as WhatsAppHighBrainClassificationRegistrar;
    setWhatsAppHighBrainClassificationRegistrar(registrar);
    expect(getWhatsAppHighBrainClassificationRegistrar()).toBe(registrar);
    expect(getOptionalWhatsAppHighBrainClassificationRegistrar()).toBe(registrar);
  });

  it("never swaps in a later registrar after first initialization", () => {
    const first = vi.fn() as unknown as WhatsAppHighBrainClassificationRegistrar;
    const second = vi.fn() as unknown as WhatsAppHighBrainClassificationRegistrar;
    setWhatsAppHighBrainClassificationRegistrar(first);
    setWhatsAppHighBrainClassificationRegistrar(second);
    expect(getWhatsAppHighBrainClassificationRegistrar()).toBe(first);
    expect(getWhatsAppHighBrainClassificationRegistrar()).not.toBe(second);
  });

  it("shares one private registrar binding between the setter sidecar and the consumer", () => {
    const registrar = vi.fn() as unknown as WhatsAppHighBrainClassificationRegistrar;
    setHighBrainViaSidecar(registrar);
    expect(getOptionalWhatsAppHighBrainClassificationRegistrar()).toBe(registrar);
    expect(getWhatsAppHighBrainClassificationRegistrar()).toBe(registrar);
  });

  it("isolates the registrar slot for tests", () => {
    setWhatsAppHighBrainClassificationRegistrar(
      vi.fn() as unknown as WhatsAppHighBrainClassificationRegistrar,
    );
    expect(getOptionalWhatsAppHighBrainClassificationRegistrar()).not.toBeNull();
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    expect(getOptionalWhatsAppHighBrainClassificationRegistrar()).toBeNull();
  });
});
