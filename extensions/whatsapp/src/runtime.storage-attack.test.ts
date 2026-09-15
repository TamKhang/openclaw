import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
// Storage-attack coverage for the WhatsApp outbound authorization registrar.
//
// The registrar must live in private module-lexical state that is unreachable
// through the public `openclaw/plugin-sdk/runtime-store` surface. These tests
// prove an attacker plugin holding only public SDK exports cannot read, clear,
// replace, or invoke the injected registrar.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setWhatsAppOutboundAuthorizationRegistrar as setViaSidecar } from "../runtime-setter-api.js";
import {
  getOptionalWhatsAppOutboundAuthorizationRegistrar,
  getWhatsAppOutboundAuthorizationRegistrar,
  resetWhatsAppOutboundAuthorizationRegistrarForTests,
  setWhatsAppOutboundAuthorizationRegistrar,
  type WhatsAppOutboundAuthorizationRegistrar,
} from "./runtime.js";

const FORMER_REGISTRAR_KEY = "plugin-runtime:whatsapp:outbound-authorization-registrar";

function fakeRegistrar(): WhatsAppOutboundAuthorizationRegistrar {
  return vi.fn() as unknown as WhatsAppOutboundAuthorizationRegistrar;
}

/** An attacker plugin's only reachable handle: the public named runtime store. */
function attackerStore() {
  return createPluginRuntimeStore<unknown>({
    key: FORMER_REGISTRAR_KEY,
    errorMessage: "WhatsApp outbound authorization registrar not initialized",
  });
}

afterEach(() => {
  attackerStore().clearRuntime();
  resetWhatsAppOutboundAuthorizationRegistrarForTests();
});

describe("WhatsApp outbound authorization registrar private storage", () => {
  it("cannot read the registrar through the former predictable runtime-store key", () => {
    const registrar = fakeRegistrar();
    setWhatsAppOutboundAuthorizationRegistrar(registrar);

    expect(attackerStore().tryGetRuntime()).toBeNull();
    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).toBe(registrar);
  });

  it("cannot clear the registrar through the former predictable runtime-store key", () => {
    const registrar = fakeRegistrar();
    setWhatsAppOutboundAuthorizationRegistrar(registrar);

    attackerStore().clearRuntime();

    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).toBe(registrar);
  });

  it("cannot replace the registrar through the former predictable runtime-store key", () => {
    const registrar = fakeRegistrar();
    const evil = fakeRegistrar();
    setWhatsAppOutboundAuthorizationRegistrar(registrar);

    attackerStore().setRuntime(evil);

    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).toBe(registrar);
    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).not.toBe(evil);
  });

  it("cannot invoke the registrar through the former predictable runtime-store key", () => {
    const registrar = fakeRegistrar();
    setWhatsAppOutboundAuthorizationRegistrar(registrar);

    const leaked = attackerStore().tryGetRuntime();
    expect(leaked).toBeNull();
    if (typeof leaked === "function") {
      leaked({ authorizationClass: "delegated_group_reply" } as never);
    }

    expect(registrar).not.toHaveBeenCalled();
  });

  it("never lets a second initialization replace the real registrar", () => {
    const first = fakeRegistrar();
    const second = fakeRegistrar();
    setWhatsAppOutboundAuthorizationRegistrar(first);
    setWhatsAppOutboundAuthorizationRegistrar(second);

    expect(getWhatsAppOutboundAuthorizationRegistrar()).toBe(first);
    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).toBe(first);
  });

  it("fails closed when initialization is missing", () => {
    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).toBeNull();
    expect(() => getWhatsAppOutboundAuthorizationRegistrar()).toThrow(/registrar not initialized/u);
  });

  it("shares one private registrar binding between the setter sidecar and the consumer", () => {
    const registrar = fakeRegistrar();
    setViaSidecar(registrar);

    expect(getOptionalWhatsAppOutboundAuthorizationRegistrar()).toBe(registrar);
    expect(getWhatsAppOutboundAuthorizationRegistrar()).toBe(registrar);
  });
});
