// Whatsapp tests cover explicit owner-delegated group reply authorization.
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
  authoritativeDisplayName?: string;
  otherParticipantNames?: string[];
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
    authoritativeDisplayName: params.authoritativeDisplayName,
    otherParticipantNames: params.otherParticipantNames,
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

  it("resolves the roster display name for a LID quoted participant even with a stale LID label", () => {
    const roster = new Map<string, string>([[TARGET_E164, "Nang Hong"]]);
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "What is the weather?",
          sender: {
            e164: TARGET_E164,
            lid: "155280281211126@lid",
            label: "155280281211126@lid",
          },
        },
      },
    });
    const result = authorize({ msg, groupMemberNames: new Map([["group@g.us", roster]]) });

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.participantId).toBe(TARGET_E164);
      expect(result.authorization.target.displayName).toBe("Nang Hong");
    }
  });

  it("prefers the roster human name over any quote-provided non-roster name", () => {
    const roster = new Map<string, string>([[TARGET_E164, "Nang Hong"]]);
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "What is the weather?",
          sender: {
            e164: TARGET_E164,
            name: "Văn",
            label: "155280281211126@lid",
          },
        },
      },
    });
    const result = authorize({ msg, groupMemberNames: new Map([["group@g.us", roster]]) });

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.displayName).toBe("Nang Hong");
    }
  });

  it("prefers authoritative metadata over the recent-sender roster", () => {
    const roster = new Map<string, string>([[TARGET_E164, "Stale Roster Name"]]);
    const msg = makeGroupReplyMessage();
    const result = authorize({
      msg,
      groupMemberNames: new Map([["group@g.us", roster]]),
      authoritativeDisplayName: "Nang Hong",
      otherParticipantNames: ["Văn", "Stale Roster Name"],
    });

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.displayName).toBe("Nang Hong");
      expect(result.authorization.target.otherParticipantNames).toEqual([
        "Văn",
        "Stale Roster Name",
      ]);
    }
  });

  it("reproduces R2 with an empty roster and authoritative Nang Hong", () => {
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "What is the weather?",
          sender: {
            e164: TARGET_E164,
            lid: "155280281211126@lid",
            name: "Văn",
            label: "155280281211126@lid",
          },
        },
      },
    });
    const result = authorize({
      msg,
      authoritativeDisplayName: "Nang Hong",
      otherParticipantNames: ["Văn"],
    });

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.participantId).toBe(TARGET_E164);
      expect(result.authorization.target.displayName).toBe("Nang Hong");
      expect(result.authorization.target.otherParticipantNames).toEqual(["Văn"]);
    }
  });

  it("does not trust an authoritative identifier as a display name", () => {
    const msg = makeGroupReplyMessage();
    const result = authorize({
      msg,
      authoritativeDisplayName: "155280281211126@lid",
      otherParticipantNames: [],
    });

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.displayName).toBeUndefined();
    }
  });

  it("never emits a raw LID as the target display name", () => {
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "What is the weather?",
          sender: {
            e164: TARGET_E164,
            lid: "155280281211126@lid",
            label: "155280281211126@lid",
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

  it("never emits a raw JID as the target display name", () => {
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "What is the weather?",
          sender: {
            jid: "84905113232@s.whatsapp.net",
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

  it("does not treat a phone-number-like roster value as a display name", () => {
    const roster = new Map<string, string>([[TARGET_E164, "+84905113232"]]);
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "What is the weather?",
          sender: {
            e164: TARGET_E164,
          },
        },
      },
    });
    const result = authorize({ msg, groupMemberNames: new Map([["group@g.us", roster]]) });

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.displayName).toBeUndefined();
    }
  });

  it("does not guess a name from quote metadata when no trusted roster name exists", () => {
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "What is the weather?",
          sender: {
            e164: TARGET_E164,
            name: "Văn",
            label: "155280281211126@lid",
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

  it("does not select the wrong participant roster entry", () => {
    const roster = new Map<string, string>([["+15550000009", "Mallory"]]);
    const msg = makeGroupReplyMessage({
      quote: {
        context: {
          id: "quoted-1",
          body: "What is the weather?",
          sender: {
            e164: TARGET_E164,
          },
        },
      },
    });
    const result = authorize({ msg, groupMemberNames: new Map([["group@g.us", roster]]) });

    expect(result.status).toBe("authorized");
    if (result.status === "authorized") {
      expect(result.authorization.target.participantId).toBe(TARGET_E164);
      expect(result.authorization.target.displayName).toBeUndefined();
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

  it("denies an unknown authorization token", () => {
    const msg = makeGroupReplyMessage();
    const authorization = authorize({ msg });
    expect(authorization.status).toBe("authorized");
    if (authorization.status !== "authorized") {
      return;
    }

    const unknownTokenMsg = {
      ...msg,
      groupReplyOnce: {
        ...msg.groupReplyOnce,
        token: "unknown-token-not-registered",
      },
    } as AdmittedWebInboundMessage;

    expect(consumeGroupReplyOnceAuthorization({ msg: unknownTokenMsg })).toMatchObject({
      status: "denied",
      reason: "no_authorization",
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

  it("denies a wrong quoted participant", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    const wrongParticipantMsg = {
      ...msg,
      quote: {
        context: {
          id: "quoted-1",
          body: "Can you help me with this?",
          sender: {
            e164: "+15550000009",
            name: "Mallory",
          },
        },
      },
    } as AdmittedWebInboundMessage;

    expect(
      consumeGroupReplyOnceAuthorization({
        msg: wrongParticipantMsg,
      }),
    ).toMatchObject({
      status: "denied",
      reason: "quoted_target_mismatch",
    });
  });

  it("denies a wrong owner trigger message id", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    const wrongTriggerMsg = {
      ...msg,
      event: {
        ...msg.event,
        id: "owner-trigger-2",
      },
    } as AdmittedWebInboundMessage;

    expect(
      consumeGroupReplyOnceAuthorization({
        msg: wrongTriggerMsg,
      }),
    ).toMatchObject({
      status: "denied",
      reason: "trigger_mismatch",
    });
  });

  it("denies a chat routing mismatch", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    const wrongChatMsg = {
      ...msg,
      platform: {
        ...msg.platform,
        chatJid: "other-chat@g.us",
      },
    } as AdmittedWebInboundMessage;

    expect(
      consumeGroupReplyOnceAuthorization({
        msg: wrongChatMsg,
      }),
    ).toMatchObject({
      status: "denied",
      reason: "chat_mismatch",
    });
  });

  it("denies an owner identity mismatch at consume time", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    const wrongOwnerMsg = {
      ...msg,
      platform: {
        ...msg.platform,
        sender: {
          e164: "+15550000009",
          name: "Stranger",
        },
      },
    } as AdmittedWebInboundMessage;

    expect(
      consumeGroupReplyOnceAuthorization({
        msg: wrongOwnerMsg,
      }),
    ).toMatchObject({
      status: "denied",
      reason: "owner_mismatch",
    });
  });

  it("permits at most one of two racing delivery claims", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");

    const firstClaimMsg = { ...msg } as AdmittedWebInboundMessage;
    const secondClaimMsg = { ...msg } as AdmittedWebInboundMessage;
    const first = consumeGroupReplyOnceAuthorization({ msg: firstClaimMsg });
    const second = consumeGroupReplyOnceAuthorization({ msg: secondClaimMsg });

    expect(first.status).toBe("authorized");
    expect(second).toMatchObject({
      status: "denied",
      reason: "already_consumed",
    });
  });
});

describe("createExplicitOwnerReplyDeliveryGate", () => {
  beforeEach(() => {
    resetGroupReplyOnceForTests();
  });

  it("permits exactly one physical delivery across multiple candidates", () => {
    const msg = makeGroupReplyMessage();
    expect(authorize({ msg }).status).toBe("authorized");
    const gate = createExplicitOwnerReplyDeliveryGate({ msg });

    expect(gate.hasTurnEligibility()).toBe(true);
    expect(gate.claimForDelivery()).toMatchObject({ status: "authorized" });
    expect(gate.claimForDelivery()).toMatchObject({
      status: "denied",
      reason: "already_consumed",
    });
  });

  it("treats an absent authorization as not required", () => {
    const msg = makeGroupReplyMessage();
    msg.groupReplyOnce = undefined;
    const gate = createExplicitOwnerReplyDeliveryGate({ msg });

    expect(gate.hasTurnEligibility()).toBe(false);
    expect(gate.claimForDelivery()).toEqual({ status: "not_required" });
  });
});
