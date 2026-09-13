import {
  claimWhatsAppOutboundAuthorizationForTransport,
  isWhatsAppAuthorizationRegistered,
} from "openclaw/plugin-sdk/whatsapp-outbound-authorization";
import { beforeEach, describe, expect, it } from "vitest";
import { hashWhatsAppSourceEventId } from "../../inbound/inbound-event-identity.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  authorizeOwnerExplicitSend,
  OWNER_EXPLICIT_SEND_TTL_MS,
  resetOwnerExplicitSendStoreForTests,
  resolveExplicitSendDestination,
} from "./owner-explicit-send.js";

const OWNER_E164 = "+15550000001";
const GROUP_JID = "84905113232-1552963395@g.us";
const NOW = 1_800_000_000_000;

function makeOwnerDm(body: string, senderE164 = OWNER_E164): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    admission: { conversation: { kind: "direct", id: senderE164 } },
    event: { id: "owner-dm-1" },
    payload: { body },
    platform: {
      chatJid: `${senderE164}@c.us`,
      recipientJid: "bot@s.whatsapp.net",
      sender: { e164: senderE164, name: "Owner" },
      self: { e164: "+15550000000" },
    },
  });
}

function authorize(body: string, cfg: Parameters<typeof authorizeOwnerExplicitSend>[0]["cfg"]) {
  return authorizeOwnerExplicitSend(
    {
      cfg,
      msg: makeOwnerDm(body),
      baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      accountId: undefined,
    },
    { now: () => NOW, createToken: () => "5d3e5f20-6b3c-4a0e-9f6a-2c9d7e2c4a1f" },
  );
}

describe("authorizeOwnerExplicitSend", () => {
  beforeEach(() => resetOwnerExplicitSendStoreForTests());

  it("mints a destination-bound single-use permit for an explicit owner group send", () => {
    const result = authorize(`send this to ${GROUP_JID}: Anyone playing today?`, {} as never);
    expect(result.status).toBe("authorized");
    if (result.status !== "authorized") {
      return;
    }
    expect(result.authorization).toMatchObject({
      authorizationClass: "owner_explicit_send",
      policyVersion: 1,
      actionType: "whatsapp.group.send",
      token: "5d3e5f20-6b3c-4a0e-9f6a-2c9d7e2c4a1f",
      ownerE164: OWNER_E164,
      groupId: GROUP_JID,
      chatId: GROUP_JID,
      createdAt: NOW,
      expiresAt: NOW + OWNER_EXPLICIT_SEND_TTL_MS,
      maxSends: 1,
    });
  });

  it("parses 'send this message to <destination>' and binds the permit to the configured group", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: { [GROUP_JID]: { name: "3C Castle Hill" } },
        },
      },
    } as never;
    const result = authorize(
      "Send this message to 3C Castle Hill: Bruno authorization test — explicit owner send.",
      cfg,
    );
    expect(result.status).toBe("authorized");
    if (result.status !== "authorized") {
      return;
    }
    expect(resolveExplicitSendDestination("3C Castle Hill", cfg)).toBe(GROUP_JID);
    expect(result.authorization).toMatchObject({
      authorizationClass: "owner_explicit_send",
      policyVersion: 1,
      actionType: "whatsapp.group.send",
      ownerE164: OWNER_E164,
      groupId: GROUP_JID,
      chatId: GROUP_JID,
      createdAt: NOW,
      expiresAt: NOW + OWNER_EXPLICIT_SEND_TTL_MS,
      maxSends: 1,
    });
    expect(result.authorization.groupId).toBe(GROUP_JID);
    expect(result.authorization.chatId).toBe(GROUP_JID);
    expect(result.authorization.maxSends).toBe(1);
    expect(result.authorization.sourceEventId).toBe(
      hashWhatsAppSourceEventId({
        accountId: "default",
        remoteJid: OWNER_E164,
        messageId: "owner-dm-1",
      }),
    );
  });

  it("enforces the 5-minute owner_explicit_send TTL", () => {
    expect(OWNER_EXPLICIT_SEND_TTL_MS).toBe(300_000);
  });

  it("resolves a configured group display name to its exact JID", () => {
    const cfg = {
      channels: {
        whatsapp: {
          groups: { [GROUP_JID]: { name: "Castle Hill" } },
        },
      },
    } as never;
    expect(authorize(`send a message to Castle Hill: Who is playing today?`, cfg).status).toBe(
      "authorized",
    );
    expect(resolveExplicitSendDestination("Castle Hill", cfg)).toBe(GROUP_JID);
    expect(resolveExplicitSendDestination(GROUP_JID, cfg)).toBe(GROUP_JID);
  });

  it("does not mint a permit for a read-only retrieval question", () => {
    expect(authorize("Check Castle Hill group for today's players", {} as never).status).toBe(
      "not_explicit_send",
    );
    expect(authorize("Find out who is playing using all sources", {} as never).status).toBe(
      "not_explicit_send",
    );
    expect(
      authorize("Check 3C Castle Hill and tell me what they are talking about.", {} as never)
        .status,
    ).toBe("not_explicit_send");
  });

  it("denies a non-owner explicit send directive", () => {
    const msg = makeOwnerDm(`send this to ${GROUP_JID}: hello`, "+15550000009");
    const result = authorizeOwnerExplicitSend(
      {
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      },
      { now: () => NOW, createToken: () => "5d3e5f20-6b3c-4a0e-9f6a-2c9d7e2c4a1f" },
    );
    expect(result).toMatchObject({ status: "denied", reason: "not_owner" });
  });

  it("denies an unknown destination", () => {
    expect(authorize("send this to Mystery Group: hello", {} as never)).toMatchObject({
      status: "denied",
      reason: "unknown_destination",
    });
  });

  it("denies a group trigger arriving on a non-direct conversation", () => {
    const msg = createTestWebInboundMessage({
      admission: { conversation: { kind: "group", id: GROUP_JID } },
      event: { id: "group-msg-1" },
      payload: { body: `send this to ${GROUP_JID}: hello` },
      platform: {
        chatJid: GROUP_JID,
        recipientJid: "bot@s.whatsapp.net",
        sender: { e164: OWNER_E164, name: "Owner" },
        self: { e164: "+15550000000" },
      },
    });
    const result = authorizeOwnerExplicitSend(
      {
        cfg: {} as never,
        msg,
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      },
      { now: () => NOW, createToken: () => "5d3e5f20-6b3c-4a0e-9f6a-2c9d7e2c4a1f" },
    );
    expect(result.status).toBe("not_explicit_send");
  });
});

describe("owner_explicit_send trusted permit chain", () => {
  beforeEach(() => resetOwnerExplicitSendStoreForTests());

  it("mint registers a trusted permit and transport claims it exactly once", () => {
    const token = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    const result = authorizeOwnerExplicitSend(
      {
        cfg: {} as never,
        msg: makeOwnerDm(`send this to ${GROUP_JID}: anyone playing today?`),
        baseMentionConfig: { mentionRegexes: [], allowFrom: [OWNER_E164] },
      },
      { now: () => NOW, createToken: () => token },
    );
    expect(result.status).toBe("authorized");
    if (result.status !== "authorized") {
      return;
    }
    const permit = result.authorization;
    expect(isWhatsAppAuthorizationRegistered(permit.token)).toBe(true);

    const first = claimWhatsAppOutboundAuthorizationForTransport({
      to: GROUP_JID,
      channel: "whatsapp",
      authorization: permit,
      now: NOW,
      originEventId: permit.sourceEventId,
    });
    expect(first.status).toBe("authorized");

    const second = claimWhatsAppOutboundAuthorizationForTransport({
      to: GROUP_JID,
      channel: "whatsapp",
      authorization: permit,
      now: NOW,
      originEventId: permit.sourceEventId,
    });
    expect(second).toEqual({ status: "denied", reasonCode: "consumed_permit" });
  });

  it("forged structurally valid permit fails the trusted claim", () => {
    const forged = {
      authorizationClass: "owner_explicit_send" as const,
      policyVersion: 1 as const,
      actionType: "whatsapp.group.send" as const,
      token: "11111111-1111-4111-8111-111111111111",
      ownerE164: OWNER_E164,
      groupId: GROUP_JID,
      chatId: GROUP_JID,
      sourceEventId: "owner-dm-1",
      createdAt: NOW,
      expiresAt: NOW + 300_000,
      maxSends: 1 as const,
    };
    expect(
      claimWhatsAppOutboundAuthorizationForTransport({
        to: GROUP_JID,
        channel: "whatsapp",
        authorization: forged,
        now: NOW,
        originEventId: "owner-dm-1",
      }),
    ).toEqual({ status: "denied", reasonCode: "unknown_authorization" });
  });
});
