// Whatsapp tests cover explicit owner-delegated group reply authorization.
import { beforeEach, describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  authorizeExplicitOwnerGroupReply,
  consumeGroupReplyOnceAuthorization,
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
      conversation: {
        kind: "group",
        id: "group@g.us",
      },
    },
    event: {
      id: "owner-trigger-1",
    },
    payload: {
      body: "Bruno, come in",
    },
    platform: {
      chatJid: "group@g.us",
      recipientJid: "bot@s.whatsapp.net",
      sender: {
        e164: OWNER_E164,
        name: "Owner",
      },
      self: {
        e164: "+15550000000",
      },
    },
    quote: {
      context: {
        id: "quoted-1",
        body: "Can you help me with this?",
        sender: {
          e164: TARGET_E164,
          name: "Alice",
        },
      },
    },
    ...overrides,
  });
}

function authorize(params: {
  msg: AdmittedWebInboundMessage;
  groupMemberNames?: Map<string, Map<string, string>>;
}) {
  return authorizeExplicitOwnerGroupReply({
    cfg: {} as never,
    msg: params.msg,
    baseMentionConfig: {
      mentionRegexes: [],
      allowFrom: [OWNER_E164],
    },
    groupHistoryKey: "group@g.us",
    groupMemberNames: params.groupMemberNames ?? new Map(),
  });
}

describe("authorizeExplicitOwnerGroupReply", () => {
  beforeEach(() => {
    resetGroupReplyOnceForTests();
  });

  it("authorizes an owner quote trigger and binds the exact target", () => {
    const msg = makeGroupReplyMessage();
    const result = authorize({ msg });

    expect(result.status).toBe("authorized");
    if (result.status !== "authorized") {
      return;
    }
    expect(result.authorization).toMatchObject({
      groupId: "group@g.us",
      chatId: "group@g.us",
      quotedMessageId: "quoted-1",
      ownerTriggerMessageId: "owner-trigger-1",
      ownerSenderId: OWNER_E164,
      consumed: false,
      target: {
        participantId: TARGET_E164,
        displayName: "Alice",
        e164: TARGET_E164,
      },
    });
    expect(msg.groupReplyOnce).toBe(result.authorization);
  });

  it("does not trigger on similar wording", () => {
    const msg = makeGroupReplyMessage({
      payload: {
        body: "Bruno come in",
      },
    });
    expect(authorize({ msg }).status).toBe("not_trigger");
  });

  it("denies a standalone trigger without a resolvable quoted message", () => {
    const msg = makeGroupReplyMessage({
      quote: undefined,
    });
    expect(authorize({ msg })).toMatchObject({
      status: "denied",
      reason: "missing_quoted_message_id",
    });
  });

  it("denies a non-owner trigger", () => {
    const msg = makeGroupReplyMessage({
      platform: {
        sender: {
          e164: "+15550000009",
          name: "Stranger",
        },
      },
    });
    expect(authorize({ msg })).toMatchObject({
      status: "denied",
      reason: "not_owner",
    });
  });

  it("denies a direct-chat trigger", () => {
    const msg = makeGroupReplyMessage({
      admission: {
        conversation: {
          kind: "direct",
          id: OWNER_E164,
        },
      },
    });
    expect(authorize({ msg })).toMatchObject({
      status: "denied",
      reason: "not_group",
    });
  });

  it("rejects replay of the same owner trigger message", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    expect(authorize({ msg })).toMatchObject({
      status: "denied",
      reason: "replay_trigger_message",
    });
  });

  it("falls back to the participant roster display name", () => {
    const roster = new Map<string, string>([[TARGET_E164, "Roster Alice"]]);
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "Can you help me with this?",
          sender: {
            e164: TARGET_E164,
          },
        },
      },
    });
    const result = authorize({ msg, groupMemberNames: new Map([["group@g.us", roster]]) });

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.displayName).toBe("Roster Alice");
    }
  });

  it("leaves the display name undefined when none is available", () => {
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "Can you help me with this?",
          sender: {
            e164: TARGET_E164,
          },
        },
      },
    });
    const result = authorize({ msg });

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.displayName).toBeUndefined();
    }
  });
});

describe("consumeGroupReplyOnceAuthorization", () => {
  beforeEach(() => {
    resetGroupReplyOnceForTests();
  });

  it("consumes an authorization exactly once", () => {
    const msg = makeGroupReplyMessage();
    const authorization = authorize({ msg });
    expect(authorization.status).toBe("authorized");
    if (authorization.status !== "authorized") {
      return;
    }

    const first = consumeGroupReplyOnceAuthorization({
      msg,
    });
    expect(first.status).toBe("authorized");
    expect(msg.groupReplyOnce?.consumed).toBe(true);

    expect(
      consumeGroupReplyOnceAuthorization({
        msg,
      }),
    ).toMatchObject({
      status: "denied",
      reason: "already_consumed",
    });
  });

  it("denies an expired authorization", () => {
    const msg = makeGroupReplyMessage();
    const authorization = authorizeExplicitOwnerGroupReply(
      {
        cfg: {} as never,
        msg,
        baseMentionConfig: {
          mentionRegexes: [],
          allowFrom: [OWNER_E164],
        },
        groupHistoryKey: "group@g.us",
        groupMemberNames: new Map(),
      },
      {
        now: () => 1_000,
        createToken: () => "token-expired",
      },
    );
    expect(authorization.status).toBe("authorized");

    expect(
      consumeGroupReplyOnceAuthorization(
        { msg },
        {
          now: () => 1_000 + GROUP_REPLY_ONCE_TTL_MS + 1,
        },
      ),
    ).toMatchObject({
      status: "denied",
      reason: "expired",
    });
  });

  it("denies a group mismatch", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    const wrongGroupMsg = {
      ...msg,
      admission: {
        ...msg.admission,
        conversation: {
          ...msg.admission.conversation,
          id: "other@g.us",
        },
      },
    } as AdmittedWebInboundMessage;

    expect(
      consumeGroupReplyOnceAuthorization({
        msg: wrongGroupMsg,
      }),
    ).toMatchObject({
      status: "denied",
      reason: "group_mismatch",
    });
  });

  it("denies a quoted target mismatch", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    const wrongQuoteMsg = {
      ...msg,
      quote: {
        context: {
          id: "quoted-2",
          body: "Can you help me with this?",
          sender: {
            e164: TARGET_E164,
            name: "Alice",
          },
        },
      },
    } as AdmittedWebInboundMessage;

    expect(
      consumeGroupReplyOnceAuthorization({
        msg: wrongQuoteMsg,
      }),
    ).toMatchObject({
      status: "denied",
      reason: "quoted_target_mismatch",
    });
  });
});
