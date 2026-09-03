import { describe, expect, it } from "vitest";
import { assertOutboundGroupReplyAuthorization } from "./deliver-core.js";

const validAuth = {
  capability: "whatsapp.group.reply_once" as const,
  token: "token",
  groupId: "group@g.us",
  chatId: "group@g.us",
  ownerTriggerMessageId: "trigger",
  quotedMessageId: "quoted",
  targetParticipantId: "+15550000002",
};

describe("outbound group reply authorization", () => {
  it("accepts valid whatsapp authorization matching the target", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: validAuth,
      }),
    ).not.toThrow();
  });

  it("allows deliveries without an authorization marker", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: undefined,
      }),
    ).not.toThrow();
  });

  it("rejects malformed authorization evidence", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "whatsapp",
        to: "group@g.us",
        authorization: { ...validAuth, token: "" },
      }),
    ).toThrow("invalid outbound group reply authorization");
  });

  it("rejects authorization for a non-whatsapp channel", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "telegram",
        to: "group@g.us",
        authorization: validAuth,
      }),
    ).toThrow("only valid for whatsapp");
  });

  it("rejects target mismatch", () => {
    expect(() =>
      assertOutboundGroupReplyAuthorization({
        channel: "whatsapp",
        to: "other@g.us",
        authorization: validAuth,
      }),
    ).toThrow("target mismatch");
  });
});
