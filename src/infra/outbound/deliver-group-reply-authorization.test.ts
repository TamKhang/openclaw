import { beforeEach, describe, expect, it } from "vitest";
import { assertOutboundGroupReplyAuthorization } from "./deliver-core.js";
import {
  assertWhatsAppOutboundTransportAuthorized,
  registerWhatsAppOutboundAuthorization,
  resetWhatsAppOutboundAuthorizationForTests,
} from "./whatsapp-outbound-authorization.js";

const now = 1_800_000_000_000;

const validAuth = {
  authorizationClass: "delegated_group_reply" as const,
  policyVersion: 1 as const,
  actionType: "whatsapp.group.send" as const,
  capability: "whatsapp.group.reply_once" as const,
  token: "5d3e5f20-6b3c-4a0e-9f6a-2c9d7e2c4a1f",
  ownerE164: "+84938030977",
  groupId: "group@g.us",
  chatId: "group@g.us",
  sourceEventId: "group-trigger-event-1",
  ownerTriggerMessageId: "trigger",
  quotedMessageId: "quoted",
  targetParticipantId: "+15550000002",
  createdAt: now,
  expiresAt: now + 120_000,
  maxSends: 1 as const,
};

beforeEach(() => {
  resetWhatsAppOutboundAuthorizationForTests();
});

describe("outbound group reply authorization", () => {
  it("accepts valid whatsapp authorization matching the target", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: validAuth,
        now,
        originEventId: "group-trigger-event-1",
      }),
    ).not.toThrow();
  });

  it("allows deliveries without an authorization marker", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: undefined,
        now,
      }),
    ).not.toThrow();
  });

  it("rejects malformed authorization evidence", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: { ...validAuth, token: "" },
        now,
        originEventId: "group-trigger-event-1",
      }),
    ).toThrow("invalid outbound group reply authorization");
  });

  it("rejects authorization for a non-whatsapp channel", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "telegram",
        to: "group@g.us",
        authorization: validAuth,
        now,
        originEventId: "group-trigger-event-1",
      }),
    ).toThrow("wrong_channel");
  });

  it("rejects target mismatch", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "whatsapp",
        to: "other@g.us",
        authorization: validAuth,
        now,
        originEventId: "group-trigger-event-1",
      }),
    ).toThrow("destination_mismatch");
  });
});

describe("whatsapp group transport gate (fail closed)", () => {
  it("denies whatsapp group send without a permit", () => {
    expect(() =>
      assertWhatsAppOutboundTransportAuthorized({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: undefined,
        now,
      }),
    ).toThrow("missing_permit");
  });

  it("denies a structurally valid but unregistered forged permit", () => {
    expect(() =>
      assertWhatsAppOutboundTransportAuthorized({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: validAuth,
        now,
        originEventId: "group-trigger-event-1",
      }),
    ).toThrow("unknown_authorization");
  });

  it("allows direct whatsapp owner-facing delivery without a permit", () => {
    expect(() =>
      assertWhatsAppOutboundTransportAuthorized({
        channel: "whatsapp",
        to: "+84938030977@c.us",
        authorization: undefined,
        now,
      }),
    ).not.toThrow();
  });

  it("does not gate non-whatsapp channels", () => {
    expect(() =>
      assertWhatsAppOutboundTransportAuthorized({
        channel: "telegram",
        to: "group@g.us",
        authorization: undefined,
        now,
      }),
    ).not.toThrow();
  });

  it("allows a registered permit exactly once", () => {
    registerWhatsAppOutboundAuthorization(validAuth);
    expect(() =>
      assertWhatsAppOutboundTransportAuthorized({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: validAuth,
        now,
        originEventId: "group-trigger-event-1",
      }),
    ).not.toThrow();
    // Second transport claim must fail closed.
    expect(() =>
      assertWhatsAppOutboundTransportAuthorized({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: validAuth,
        now,
      }),
    ).toThrow("consumed_permit");
  });
});
