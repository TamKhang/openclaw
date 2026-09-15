// High Brain trigger recognition: DM form is exact `Bruno, high brain: <query>`
// (case/punctuation/spacing-sensitive), group form is the bare trigger plus
// exactly one quoted message. Recognition is owner-authorized, host-derived,
// one-shot, and separate from delegated_group_reply send authorization.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  resetWhatsAppHighBrainClassificationRegistrarForTests,
  resetWhatsAppOutboundAuthorizationRegistrarForTests,
  setWhatsAppHighBrainClassificationRegistrar,
  setWhatsAppOutboundAuthorizationRegistrar,
  type WhatsAppHighBrainClassificationRegistrar,
  type WhatsAppOutboundAuthorizationRegistrar,
} from "../../runtime.js";
import { applyGroupGating, type GroupHistoryEntry } from "./group-gating.js";
import {
  authorizeExplicitOwnerGroupReply,
  resetGroupReplyOnceForTests,
} from "./group-reply-once.js";
import {
  authorizeHighBrainDm,
  authorizeHighBrainGroup,
  parseHighBrainDmBody,
} from "./high-brain.js";

const OWNER_E164 = "+15550000001";
const TARGET_E164 = "+15550000002";
const HIGH_BRAIN_TRIGGER_PREFIX = "Bruno, high brain:";

function makeDmMessage(body: string, senderE164 = OWNER_E164): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    admission: { conversation: { kind: "direct", id: senderE164 } },
    event: { id: "dm-event-1" },
    payload: { body },
    platform: {
      chatJid: senderE164,
      recipientJid: "+15550000000",
      sender: { e164: senderE164, name: "Owner" },
      self: { e164: "+15550000000" },
    },
  });
}

function makeGroupReplyMessage(
  overrides: Partial<Parameters<typeof createTestWebInboundMessage>[0]> = {},
): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    admission: { conversation: { kind: "group", id: "group@g.us" } },
    event: { id: "group-event-1" },
    payload: { body: HIGH_BRAIN_TRIGGER_PREFIX },
    platform: {
      chatJid: "group@g.us",
      recipientJid: "bot@s.whatsapp.net",
      sender: { e164: OWNER_E164, name: "Owner" },
      self: { e164: "+15550000000" },
    },
    quote: {
      context: {
        id: "quoted-1",
        body: "Plan the multi-stage production rollout for the dev GitHub pipeline.",
        sender: { e164: TARGET_E164, name: "Alice" },
      },
    },
    ...overrides,
  });
}

const highBrainRegistrarMock = vi.fn<WhatsAppHighBrainClassificationRegistrar>();
const sendRegistrarMock = vi.fn<WhatsAppOutboundAuthorizationRegistrar>();

function authorizeGroup(msg: AdmittedWebInboundMessage) {
  return authorizeHighBrainGroup({
    cfg: {} as never,
    msg,
    baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
    groupHistoryKey: "group@g.us",
    groupMemberNames: new Map(),
  });
}

beforeEach(() => {
  resetGroupReplyOnceForTests();
  resetWhatsAppHighBrainClassificationRegistrarForTests();
  resetWhatsAppOutboundAuthorizationRegistrarForTests();
  highBrainRegistrarMock.mockClear();
  sendRegistrarMock.mockClear();
  setWhatsAppHighBrainClassificationRegistrar(highBrainRegistrarMock);
  setWhatsAppOutboundAuthorizationRegistrar(sendRegistrarMock);
});

describe("parseHighBrainDmBody", () => {
  it("parses the exact canonical form and strips only the trigger prefix", () => {
    expect(parseHighBrainDmBody("Bruno, high brain: Plan the rollout")).toEqual({
      status: "trigger",
      query: "Plan the rollout",
    });
  });

  it.each([
    "Bruno, high brain:Plan the rollout", // wrong spacing (no space)
    "Bruno, high brain:  Plan the rollout", // wrong spacing (two spaces)
  ])("rejects wrong spacing: %j", (body) => {
    expect(parseHighBrainDmBody(body)).toMatchObject({
      status: "malformed",
      reason: "wrong_spacing",
    });
  });

  it.each(["Bruno, high brain:", "Bruno, high brain: ", "Bruno, high brain:   "])(
    "rejects an empty or whitespace-only query: %j",
    (body) => {
      expect(parseHighBrainDmBody(body)).toMatchObject({ status: "malformed" });
    },
  );

  it.each([
    "bruno, high brain: Plan", // wrong case
    "Bruno, high brain; Plan", // wrong punctuation
    "Bruno high brain: Plan", // missing comma
    "Bruno, high brain : Plan", // wrong spacing before colon
    "Hey Bruno, high brain: Plan", // extra prefix text
  ])("does not trigger on %j", (body) => {
    expect(parseHighBrainDmBody(body).status).toBe("not_trigger");
  });
});

describe("authorizeHighBrainDm", () => {
  it("authorizes a valid owner DM and strips the prefix from the query", () => {
    const msg = makeDmMessage("Bruno, high brain: Plan the rollout");
    const result = authorizeHighBrainDm({
      cfg: {} as never,
      msg,
      baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
    });
    expect(result).toMatchObject({ status: "authorized", mode: "dm", query: "Plan the rollout" });
    expect(highBrainRegistrarMock).toHaveBeenCalledTimes(1);
    const override = highBrainRegistrarMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(override).toMatchObject({ policyVersion: 1, mode: "dm", requestedTier: "high" });
  });

  it("denies a non-owner DM", () => {
    const msg = makeDmMessage("Bruno, high brain: Plan the rollout", "+15550000009");
    expect(
      authorizeHighBrainDm({
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      }),
    ).toMatchObject({ status: "denied", reason: "not_owner" });
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });

  it("does not trigger a malformed bare trigger in DM", () => {
    const msg = makeDmMessage("Bruno, high brain:");
    expect(
      authorizeHighBrainDm({
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      }).status,
    ).toBe("not_trigger");
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });

  it("denies an exact owner DM when the High Brain registrar is unavailable", () => {
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    const msg = makeDmMessage("Bruno, high brain: Plan the rollout");
    expect(
      authorizeHighBrainDm({
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      }),
    ).toMatchObject({ status: "denied", reason: "high_brain_registration_unavailable" });
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });

  it("denies an exact owner DM when the High Brain registrar throws", () => {
    const throwing = vi.fn<WhatsAppHighBrainClassificationRegistrar>(() => {
      throw new Error("registrar boom");
    });
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    setWhatsAppHighBrainClassificationRegistrar(throwing);
    const msg = makeDmMessage("Bruno, high brain: Plan the rollout");
    expect(
      authorizeHighBrainDm({
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      }),
    ).toMatchObject({ status: "denied", reason: "high_brain_registration_threw" });
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("denies an exact owner DM when the High Brain registrar refuses registration", () => {
    const refusing = vi.fn(() => ({
      ok: false,
    })) as unknown as WhatsAppHighBrainClassificationRegistrar;
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    setWhatsAppHighBrainClassificationRegistrar(refusing);
    const msg = makeDmMessage("Bruno, high brain: Plan the rollout");
    expect(
      authorizeHighBrainDm({
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      }),
    ).toMatchObject({ status: "denied", reason: "high_brain_registration_refused" });
    expect(refusing).toHaveBeenCalledTimes(1);
  });

  it("denies an exact owner DM without a stable inbound event identity", () => {
    const msg = makeDmMessage("Bruno, high brain: Plan the rollout");
    msg.event = {};
    expect(
      authorizeHighBrainDm({
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      }),
    ).toMatchObject({
      status: "denied",
      reason: "unstable_source_event_identity:missing_message_id",
    });
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });

  it("does not trigger in a group-shaped message", () => {
    const msg = makeGroupReplyMessage();
    expect(
      authorizeHighBrainDm({
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      }).status,
    ).toBe("not_trigger");
  });
});

describe("authorizeHighBrainGroup", () => {
  it("authorizes an owner bare group trigger with a quoted message", () => {
    const msg = makeGroupReplyMessage();
    const result = authorizeGroup(msg);
    expect(result).toMatchObject({ status: "authorized", mode: "group" });
    if (result.status === "authorized") {
      expect(result.query).toBe(
        "Plan the multi-stage production rollout for the dev GitHub pipeline.",
      );
    }
    // The delegated send authorization and the HIGH classification override
    // are separate registered facts.
    expect(msg.groupReplyOnce).toBeDefined();
    expect(msg.groupReplyOnce?.authorizationClass).toBe("delegated_group_reply");
    expect(sendRegistrarMock).toHaveBeenCalledTimes(1);
    expect(highBrainRegistrarMock).toHaveBeenCalledTimes(1);
    const override = highBrainRegistrarMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(override).toMatchObject({ policyVersion: 1, mode: "group", requestedTier: "high" });
    expect(override.sourceEventId).toBe(msg.groupReplyOnce?.sourceEventId);
  });

  it("retains the quoted author for addressee behavior", () => {
    const msg = makeGroupReplyMessage();
    const result = authorizeGroup(msg);
    expect(result.status).toBe("authorized");
    expect(msg.groupReplyOnce?.target.participantId).toBe(TARGET_E164);
    expect(msg.groupReplyOnce?.quotedMessageId).toBe("quoted-1");
  });

  it("denies a non-owner group trigger", () => {
    const msg = makeGroupReplyMessage({
      platform: { sender: { e164: "+15550000009", name: "Stranger" } },
    });
    expect(authorizeGroup(msg)).toMatchObject({ status: "denied", reason: "not_owner" });
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
    expect(sendRegistrarMock).not.toHaveBeenCalled();
  });

  it("denies an owner group trigger without a quoted message", () => {
    const msg = makeGroupReplyMessage({ quote: undefined });
    expect(authorizeGroup(msg)).toMatchObject({
      status: "denied",
      reason: "missing_quoted_message_id",
    });
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });

  it("denies an owner group trigger with inline text", () => {
    const msg = makeGroupReplyMessage({ payload: { body: "Bruno, high brain: inline query" } });
    expect(authorizeGroup(msg).status).toBe("not_trigger");
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });

  it("does not trigger from quoted content alone", () => {
    const msg = makeGroupReplyMessage({ payload: { body: "hello" } });
    expect(authorizeGroup(msg).status).toBe("not_trigger");
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });

  it("reuses the exact delegated_group_reply transport authorization", () => {
    const msg = makeGroupReplyMessage();
    expect(authorizeGroup(msg).status).toBe("authorized");
    const delegated = sendRegistrarMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(delegated).toMatchObject({
      authorizationClass: "delegated_group_reply",
      policyVersion: 1,
      actionType: "whatsapp.group.send",
      capability: "whatsapp.group.reply_once",
      maxSends: 1,
    });
  });

  it("does not trigger in a DM-shaped message", () => {
    const msg = makeDmMessage("Bruno, high brain:");
    expect(authorizeGroup(msg).status).toBe("not_trigger");
  });

  it("fails closed when High Brain registration fails after the send permit is minted", () => {
    // Coverage for the partial-registration ordering: the delegated_group_reply
    // send permit is minted and registered BEFORE the High Brain override. When
    // the High Brain registrar is missing the attempt must still be denied, and
    // the dangling permit must never authorize a model dispatch or physical send.
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    const msg = makeGroupReplyMessage();
    const result = authorizeGroup(msg);
    expect(result).toMatchObject({
      status: "denied",
      reason: "high_brain_registration_unavailable",
    });
    // The delegated send permit was minted and registered (dangling state)...
    expect(sendRegistrarMock).toHaveBeenCalledTimes(1);
    expect(msg.groupReplyOnce).toBeDefined();
    // ...but the High Brain override was never registered.
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });
});

describe("applyGroupGating partial-registration fail-closed", () => {
  it("skips processing when the send permit is minted but High Brain registration fails", async () => {
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    const msg = makeGroupReplyMessage();
    const logVerbose = vi.fn<(msg: string) => void>();
    const warn = vi.fn<(obj: unknown, msg: string) => void>();

    const result = await applyGroupGating({
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: [OWNER_E164],
            groupPolicy: "allowlist",
            groups: { "group@g.us": {} },
          },
        },
      } as never,
      msg,
      groupHistoryKey: "group@g.us",
      agentId: "main",
      sessionKey: "agent:main:whatsapp:group:group@g.us",
      baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      groupHistories: new Map<string, GroupHistoryEntry[]>(),
      groupHistoryLimit: 20,
      groupMemberNames: new Map(),
      logVerbose,
      replyLogger: { debug: vi.fn(), warn },
    });

    // Gating rejects the turn, so processMessage (model dispatch) never runs.
    expect(result).toEqual({ shouldProcess: false });
    // The delegated_group_reply send permit was minted and registered BEFORE the
    // High Brain registration failure (the dangling permit)...
    expect(sendRegistrarMock).toHaveBeenCalledTimes(1);
    expect(msg.groupReplyOnce).toBeDefined();
    // ...but no High Brain override was registered, so no physical send path can
    // be reached for this trigger.
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });
});

describe("ordinary Bruno, come in remains unaffected", () => {
  it("authorizes the ordinary delegated reply without a High Brain override", () => {
    const msg = createTestWebInboundMessage({
      admission: { conversation: { kind: "group", id: "group@g.us" } },
      event: { id: "come-in-event-1" },
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
    });
    const result = authorizeExplicitOwnerGroupReply({
      cfg: {} as never,
      msg,
      baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      groupHistoryKey: "group@g.us",
      groupMemberNames: new Map(),
    });
    expect(result.status).toBe("authorized");
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
    expect(sendRegistrarMock).toHaveBeenCalledTimes(1);
  });
});
