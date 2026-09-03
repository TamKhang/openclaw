import { describe, expect, it } from "vitest";
import {
  hashWhatsAppSourceEventId,
  resolveWhatsAppInboundEventIdentity,
} from "./inbound-event-identity.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

describe("WhatsApp inbound event identity", () => {
  it("resolves a stable source event id", () => {
    const msg = createTestWebInboundMessage({ event: { id: "message-1" } });
    const result = resolveWhatsAppInboundEventIdentity(msg);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.sourceEventId).toBe(
        hashWhatsAppSourceEventId({
          accountId: "default",
          remoteJid: "+15551234567",
          messageId: "message-1",
        }),
      );
    }
  });

  it("is unresolved without a message id", () => {
    const msg = createTestWebInboundMessage({ event: { id: undefined } });
    expect(resolveWhatsAppInboundEventIdentity(msg)).toEqual({
      status: "unresolved",
      reason: "missing_message_id",
    });
  });
});
