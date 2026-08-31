import type { GroupMetadata, GroupParticipant } from "baileys";
// Whatsapp tests cover authoritative group participant name resolution.
import { describe, expect, it } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import {
  buildGroupReplyAgentBody,
  formatAuthoritativeGroupReplyText,
  readTrustedWhatsAppDisplayName,
  resolveAuthoritativeGroupReplyTarget,
  resolveGroupParticipantName,
} from "./group-participant-name.js";

const GROUP_ID = "84905113232-1552963395@g.us";
const TARGET_E164 = "+84905113232";
const TARGET_LID = "155280281211126@lid";
const TARGET_PN_JID = "84905113232@s.whatsapp.net";

function participant(overrides: Partial<GroupParticipant> = {}): GroupParticipant {
  return {
    id: TARGET_LID,
    lid: TARGET_LID,
    phoneNumber: TARGET_PN_JID,
    verifiedName: "Nang Hong",
    ...overrides,
  };
}

function metadata(participants: GroupParticipant[]): GroupMetadata {
  return {
    id: GROUP_ID,
    owner: "owner@s.whatsapp.net",
    subject: "3C Castle Hill",
    participants,
  };
}

function makeReplyMessage(
  overrides: Partial<Parameters<typeof createTestWebInboundMessage>[0]> = {},
): AdmittedWebInboundMessage {
  return createTestWebInboundMessage({
    admission: {
      conversation: {
        kind: "group",
        id: GROUP_ID,
      },
    },
    platform: {
      chatJid: GROUP_ID,
      recipientJid: "bot@s.whatsapp.net",
      sender: {
        e164: "+84905110000",
        name: "Owner",
      },
      self: {
        e164: "+84905110001",
      },
    },
    quote: {
      context: {
        id: "quoted-1",
        body: "What time is the pickup?",
        sender: {
          e164: TARGET_E164,
          lid: TARGET_LID,
          name: "Nang Hong",
        },
      },
    },
    ...overrides,
  });
}

describe("readTrustedWhatsAppDisplayName", () => {
  it("accepts a human display name", () => {
    expect(readTrustedWhatsAppDisplayName("Nang Hong")).toBe("Nang Hong");
  });

  it("rejects raw LID, raw JID, E.164, and bare phone strings", () => {
    expect(readTrustedWhatsAppDisplayName(TARGET_LID)).toBeUndefined();
    expect(readTrustedWhatsAppDisplayName(TARGET_PN_JID)).toBeUndefined();
    expect(readTrustedWhatsAppDisplayName("84905113232@g.us")).toBeUndefined();
    expect(readTrustedWhatsAppDisplayName(TARGET_E164)).toBeUndefined();
    expect(readTrustedWhatsAppDisplayName("84905113232")).toBeUndefined();
    expect(readTrustedWhatsAppDisplayName("Unknown Sender")).toBeUndefined();
  });
});

describe("resolveGroupParticipantName", () => {
  it("resolves a quoted LID sender through the verified LID/PN participant", () => {
    const result = resolveGroupParticipantName({
      metadata: metadata([participant()]),
      sender: { e164: TARGET_E164, lid: TARGET_LID },
    });
    expect(result.displayName).toBe("Nang Hong");
    expect(result.otherParticipantNames).not.toContain("Nang Hong");
  });

  it("resolves a quoted E.164 sender to the same participant", () => {
    const result = resolveGroupParticipantName({
      metadata: metadata([participant()]),
      sender: { e164: TARGET_E164 },
    });
    expect(result.displayName).toBe("Nang Hong");
  });

  it("prefers the trusted name over a stale raw-LID label", () => {
    const result = resolveGroupParticipantName({
      metadata: metadata([
        participant({
          verifiedName: "Nang Hong",
          notify: TARGET_LID,
          name: TARGET_LID,
        }),
      ]),
      sender: { e164: TARGET_E164, lid: TARGET_LID },
    });
    expect(result.displayName).toBe("Nang Hong");
  });

  it("does not return a raw identifier as a display name", () => {
    const result = resolveGroupParticipantName({
      metadata: metadata([
        participant({
          verifiedName: TARGET_LID,
          notify: TARGET_PN_JID,
          name: TARGET_E164,
        }),
      ]),
      sender: { e164: TARGET_E164, lid: TARGET_LID },
    });
    expect(result.displayName).toBeUndefined();
  });

  it("is cold-cache safe and does not depend on a recent-sender roster", () => {
    const result = resolveGroupParticipantName({
      metadata: metadata([participant()]),
      sender: { e164: TARGET_E164, lid: TARGET_LID },
    });
    expect(result.displayName).toBe("Nang Hong");
  });

  it("cannot select a participant from the wrong group", () => {
    const result = resolveGroupParticipantName({
      metadata: metadata([
        participant({
          id: "other@lid",
          lid: "other@lid",
          phoneNumber: "1999@s.whatsapp.net",
          verifiedName: "Other Person",
        }),
      ]),
      sender: { e164: TARGET_E164, lid: TARGET_LID },
    });
    expect(result.displayName).toBeUndefined();
  });

  it("cannot select a wrong participant", () => {
    const result = resolveGroupParticipantName({
      metadata: metadata([
        participant({
          id: "84999999999@s.whatsapp.net",
          lid: undefined,
          phoneNumber: "84999999999@s.whatsapp.net",
          verifiedName: "Mallory",
        }),
      ]),
      sender: { e164: TARGET_E164, lid: TARGET_LID },
    });
    expect(result.displayName).toBeUndefined();
  });
});

describe("resolveAuthoritativeGroupReplyTarget", () => {
  it("uses the quoted-message author as the authoritative target", async () => {
    const result = await resolveAuthoritativeGroupReplyTarget({
      msg: makeReplyMessage(),
      groupId: GROUP_ID,
      resolveGroupMetadata: async () => metadata([participant()]),
    });
    expect(result.displayName).toBe("Nang Hong");
  });

  it("returns nameless when metadata lookup fails", async () => {
    const result = await resolveAuthoritativeGroupReplyTarget({
      msg: makeReplyMessage(),
      groupId: GROUP_ID,
      resolveGroupMetadata: async () => null,
    });
    expect(result.displayName).toBeUndefined();
    expect(result.otherParticipantNames).toEqual([]);
  });

  it("returns nameless when metadata lookup rejects", async () => {
    const result = await resolveAuthoritativeGroupReplyTarget({
      msg: makeReplyMessage(),
      groupId: GROUP_ID,
      resolveGroupMetadata: async () => {
        throw new Error("timeout");
      },
    });
    expect(result.displayName).toBeUndefined();
    expect(result.otherParticipantNames).toEqual([]);
  });
});

describe("formatAuthoritativeGroupReplyText", () => {
  it("forces Nang Hong even when the model guessed Van", () => {
    expect(
      formatAuthoritativeGroupReplyText({
        body: "Văn, nghe nè",
        displayName: "Nang Hong",
        otherParticipantNames: ["Văn"],
      }),
    ).toBe("Nang Hong, nghe nè");
  });

  it("does not double-add the authoritative name", () => {
    expect(
      formatAuthoritativeGroupReplyText({
        body: "Nang Hong, nghe nè",
        displayName: "Nang Hong",
        otherParticipantNames: ["Văn"],
      }),
    ).toBe("Nang Hong, nghe nè");
  });

  it("removes a guessed name when there is no trustworthy name", () => {
    expect(
      formatAuthoritativeGroupReplyText({
        body: "Văn, nghe nè",
        otherParticipantNames: ["Văn", "Nang Hong"],
      }),
    ).toBe("nghe nè");
  });
});

describe("buildGroupReplyAgentBody", () => {
  it("instructs the model to answer the quote without naming anyone", () => {
    const body = buildGroupReplyAgentBody({
      quotedBody: "What time is the pickup?",
    });
    expect(body).toContain("Owner delegated you to reply to the quoted group member.");
    expect(body).toContain("What time is the pickup?");
    expect(body).toContain("do not infer or invent a participant name");
  });
});
