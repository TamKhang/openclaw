// WhatsApp tests cover the canonical source-event identity shared by
// observation dedupe and reply delegation.
import { describe, expect, it } from "vitest";
import {
  hashWhatsAppSourceEventId,
  resolveWhatsAppInboundEventIdentity,
} from "./inbound-event-identity.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";

describe("resolveWhatsAppInboundEventIdentity", () => {
  it("derives the same source event id for replays of the same account/conversation/message", () => {
    const first = createTestWebInboundMessage({
      admission: {
        accountId: "default",
        conversation: { kind: "group", id: "group@g.us" },
      },
      event: { id: "owner-trigger-1" },
      platform: { chatJid: "group@g.us", sender: { e164: "+15550000001" } },
      payload: { body: "Bruno, come in" },
    });
    const replayed = createTestWebInboundMessage({
      admission: {
        accountId: "default",
        conversation: { kind: "group", id: "group@g.us" },
      },
      event: { id: "owner-trigger-1" },
      platform: { chatJid: "group@g.us", sender: { e164: "+15550000009" } },
      payload: { body: "Bruno, come in" },
    });

    const firstIdentity = resolveWhatsAppInboundEventIdentity(first);
    const replayedIdentity = resolveWhatsAppInboundEventIdentity(replayed);

    expect(firstIdentity.status).toBe("resolved");
    expect(replayedIdentity.status).toBe("resolved");
    if (firstIdentity.status !== "resolved" || replayedIdentity.status !== "resolved") {
      return;
    }
    expect(firstIdentity.sourceEventId).toBe(replayedIdentity.sourceEventId);
    expect(firstIdentity.sourceEventId).toBe(
      hashWhatsAppSourceEventId({
        accountId: "default",
        remoteJid: "group@g.us",
        messageId: "owner-trigger-1",
      }),
    );
  });

  it("fails closed when a stable message id cannot be established", () => {
    const msg = createTestWebInboundMessage({
      admission: {
        accountId: "default",
        conversation: { kind: "group", id: "group@g.us" },
      },
      event: { id: undefined },
    });

    expect(resolveWhatsAppInboundEventIdentity(msg)).toMatchObject({
      status: "unresolved",
      reason: "missing_message_id",
    });
  });
});
