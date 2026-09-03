import { beforeEach, describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  authorizeExplicitOwnerGroupReply,
  consumeGroupReplyOnceAuthorization,
  createExplicitOwnerReplyDeliveryGate,
  GROUP_REPLY_ONCE_TTL_MS,
  resetGroupReplyOnceForTests,
} from "./group-reply-once.js";

const OWNER_E164 = "+15550000001";
const TARGET_E164 = "+15550000002";

function makeGroupReplyMessage(
  overrides: Partial<Parameters<typeof createTestWebInboundMessage>[0]> = {},
): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    admission: {
      conversation: { kind: "group", id: "group@g.us" },
    },
    event: { id: "owner-trigger-1" },
    payload: { body: "Bruno, come in" },
    platform: {
      chatJid: "group@g.us",
      recipientJid: "bot@s.whatsapp.net",
      sender: { e164: OWNER_E164, name: "Owner" },
      self: { e164: "+15550000000" },
    },
    quote: {
      context: {
        id: "quoted-1",
        body: "Can you help me with this?",
        sender: { e164: TARGET_E164, name: "Alice" },
      },
    },
    ...overrides,
  });
}

function authorize(params: {
  msg: AdmittedWebInboundMessage;
  groupMemberNames?: Map<string, Map<string, string>>;
  authoritativeDisplayName?: string;
  otherParticipantNames?: string[];
}) {
  return authorizeExplicitOwnerGroupReply({
    cfg: {} as never,
    msg: params.msg,
    baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
    groupHistoryKey: "group@g.us",
    groupMemberNames: params.groupMemberNames ?? new Map(),
    authoritativeDisplayName: params.authoritativeDisplayName,
    otherParticipantNames: params.otherParticipantNames,
  });
}

describe("authorizeExplicitOwnerGroupReply", () => {
  beforeEach(() => resetGroupReplyOnceForTests());

  it("authorizes an owner quote trigger and binds the exact target", () => {
    const msg = makeGroupReplyMessage();
    const result = authorize({ msg });
    expect(result.status).toBe("authorized");
    if (result.status !== "authorized") return;
    expect(result.authorization).toMatchObject({
      groupId: "group@g.us",
      chatId: "group@g.us",
      quotedMessageId: "quoted-1",
      ownerTriggerMessageId: "owner-trigger-1",
      ownerSenderId: OWNER_E164,
      consumed: false,
      target: { participantId: TARGET_E164, e164: TARGET_E164 },
    });
  });

  it("does not trigger on similar wording", () => {
    expect(
      authorize({ msg: makeGroupReplyMessage({ payload: { body: "Bruno come in" } }) }).status,
    ).toBe("not_trigger");
  });

  it("denies a standalone trigger without a quoted message", () => {
    expect(authorize({ msg: makeGroupReplyMessage({ quote: undefined }) })).toMatchObject({
      status: "denied",
      reason: "missing_quoted_message_id",
    });
  });

  it("denies a non-owner trigger", () => {
    const msg = makeGroupReplyMessage({
      platform: { sender: { e164: "+15550000009", name: "Stranger" } },
    });
    expect(authorize({ msg })).toMatchObject({ status: "denied", reason: "not_owner" });
  });

  it("falls back to the participant roster display name", () => {
    const roster = new Map<string, string>([[TARGET_E164, "Roster Alice"]]);
    const result = authorize({
      msg: makeGroupReplyMessage(),
      groupMemberNames: new Map([["group@g.us", roster]]),
    });
    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.displayName).toBe("Roster Alice");
    }
  });
});

describe("consumeGroupReplyOnceAuthorization", () => {
  beforeEach(() => resetGroupReplyOnceForTests());

  it("consumes an authorization exactly once", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    expect(consumeGroupReplyOnceAuthorization({ msg }).status).toBe("authorized");
    expect(msg.groupReplyOnce?.consumed).toBe(true);
    expect(consumeGroupReplyOnceAuthorization({ msg })).toMatchObject({
      status: "denied",
      reason: "already_consumed",
    });
  });

  it("denies an expired authorization", () => {
    const msg = makeGroupReplyMessage();
    const result = authorizeExplicitOwnerGroupReply(
      {
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
        groupHistoryKey: "group@g.us",
        groupMemberNames: new Map(),
      },
      { now: () => 1_000, createToken: () => "token-expired" },
    );
    expect(result.status).toBe("authorized");
    expect(
      consumeGroupReplyOnceAuthorization(
        { msg },
        { now: () => 1_000 + GROUP_REPLY_ONCE_TTL_MS + 1 },
      ),
    ).toMatchObject({ status: "denied", reason: "expired" });
  });

  it("denies a wrong owner trigger message id", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    const wrong = {
      ...msg,
      event: { ...msg.event, id: "owner-trigger-2" },
    } as AdmittedWebInboundMessage;
    expect(consumeGroupReplyOnceAuthorization({ msg: wrong })).toMatchObject({
      status: "denied",
      reason: "trigger_mismatch",
    });
  });
});

describe("createExplicitOwnerReplyDeliveryGate", () => {
  beforeEach(() => resetGroupReplyOnceForTests());

  it("permits exactly one physical delivery", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    const gate = createExplicitOwnerReplyDeliveryGate({ msg });
    expect(gate.hasTurnEligibility()).toBe(true);
    expect(gate.claimForDelivery()).toMatchObject({ status: "authorized" });
    expect(gate.claimForDelivery()).toMatchObject({ status: "denied", reason: "already_consumed" });
  });

  it("treats an absent authorization as not required", () => {
    const msg = makeGroupReplyMessage();
    msg.groupReplyOnce = undefined;
    const gate = createExplicitOwnerReplyDeliveryGate({ msg });
    expect(gate.hasTurnEligibility()).toBe(false);
    expect(gate.claimForDelivery()).toEqual({ status: "not_required" });
  });
});
