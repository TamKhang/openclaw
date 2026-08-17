import { describe, expect, it } from "vitest";
import {
  WhatsAppGroupOutboundDeniedError,
  assertWhatsAppOutboundAllowed,
  classifyWhatsAppDestination,
} from "./outbound-destination-safety.js";

describe("WhatsApp outbound destination safety", () => {
  it.each([
    ["120363000000000000@g.us", "group"],
    [" 120363000000000000@G.US ", "group"],
    ["15551234567@s.whatsapp.net", "direct"],
    ["277038292303944@lid", "direct"],
    ["120363000000000000@newsletter", "newsletter"],
    ["", "unknown"],
    ["120363000000000000@g.us.invalid", "unknown"],
    ["malformed", "unknown"],
  ] as const)("classifies %j as %s", (destination, expected) => {
    expect(classifyWhatsAppDestination(destination)).toBe(expected);
  });

  it("fails closed for a resolved group destination", () => {
    expect(() => assertWhatsAppOutboundAllowed("120363000000000000@g.us")).toThrow(
      WhatsAppGroupOutboundDeniedError,
    );
  });

  it.each(["15551234567@s.whatsapp.net", "277038292303944@lid", "120@newsletter"])(
    "allows non-group destination %s",
    (destination) => {
      expect(() => assertWhatsAppOutboundAllowed(destination)).not.toThrow();
    },
  );
});
