import { beforeEach, describe, expect, it } from "vitest";
import {
  claimWhatsAppOutboundAuthorizationForTransport,
  isWhatsAppGroupDestination,
  registerWhatsAppOutboundAuthorization,
  resetWhatsAppOutboundAuthorizationForTests,
  validateWhatsAppOutboundAuthorization,
} from "./whatsapp-outbound-authorization.js";

const now = 1_800_000_000_000;
const GROUP = "84905113232-1552963395@g.us";
const ORIGIN = "owner-dm-event-1";

function ownerPermit(overrides: Partial<ReturnType<typeof permit>> = {}) {
  return { ...permit(), ...overrides };
}

function permit() {
  return {
    authorizationClass: "owner_explicit_send" as const,
    policyVersion: 1 as const,
    actionType: "whatsapp.group.send" as const,
    token: "5d3e5f20-6b3c-4a0e-9f6a-2c9d7e2c4a1f",
    ownerE164: "+84938030977",
    groupId: GROUP,
    chatId: GROUP,
    sourceEventId: ORIGIN,
    createdAt: now,
    expiresAt: now + 300_000,
    maxSends: 1 as const,
  };
}

function delegatedPermit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...permit(),
    authorizationClass: "delegated_group_reply" as const,
    capability: "whatsapp.group.reply_once" as const,
    ownerTriggerMessageId: "trigger",
    quotedMessageId: "quoted",
    targetParticipantId: "target",
    ...overrides,
  };
}

function claim(authorization: unknown, to = GROUP, originEventId: string | undefined = ORIGIN) {
  return claimWhatsAppOutboundAuthorizationForTransport({
    to,
    channel: "whatsapp",
    authorization,
    now,
    originEventId,
  });
}

beforeEach(() => {
  resetWhatsAppOutboundAuthorizationForTests();
});

describe("isWhatsAppGroupDestination", () => {
  it("recognizes group JIDs and rejects direct chat JIDs", () => {
    expect(isWhatsAppGroupDestination(GROUP)).toBe(true);
    expect(isWhatsAppGroupDestination("+84938030977@c.us")).toBe(false);
    expect(isWhatsAppGroupDestination(undefined)).toBe(false);
  });
});

describe("validateWhatsAppOutboundAuthorization (structural only)", () => {
  it("denies missing permit", () => {
    expect(
      validateWhatsAppOutboundAuthorization(undefined, { to: GROUP, channel: "whatsapp", now }),
    ).toEqual({ status: "denied", reasonCode: "missing_permit" });
  });

  it("denies malformed permit", () => {
    expect(
      validateWhatsAppOutboundAuthorization({}, { to: GROUP, channel: "whatsapp", now }),
    ).toEqual({ status: "denied", reasonCode: "unknown_authorization_class" });
    expect(
      validateWhatsAppOutboundAuthorization(ownerPermit({ token: "not-a-uuid" }), {
        to: GROUP,
        channel: "whatsapp",
        now,
      }),
    ).toEqual({ status: "denied", reasonCode: "invalid_token" });
    expect(
      validateWhatsAppOutboundAuthorization(ownerPermit({ expiresAt: Number.NaN }), {
        to: GROUP,
        channel: "whatsapp",
        now,
      }),
    ).toEqual({ status: "denied", reasonCode: "malformed_permit" });
  });

  it("denies missing origin identity", () => {
    expect(
      validateWhatsAppOutboundAuthorization(ownerPermit({ sourceEventId: "" }), {
        to: GROUP,
        channel: "whatsapp",
        now,
      }),
    ).toEqual({ status: "denied", reasonCode: "missing_origin" });
  });

  it("denies unknown authorization class", () => {
    expect(
      validateWhatsAppOutboundAuthorization(
        ownerPermit({ authorizationClass: "model_invented" as never }),
        { to: GROUP, channel: "whatsapp", now },
      ),
    ).toEqual({ status: "denied", reasonCode: "unknown_authorization_class" });
  });

  it("denies expired permit", () => {
    expect(
      validateWhatsAppOutboundAuthorization(
        ownerPermit({ createdAt: now - 600_000, expiresAt: now - 1 }),
        { to: GROUP, channel: "whatsapp", now },
      ),
    ).toEqual({ status: "denied", reasonCode: "expired_permit" });
  });

  it("denies destination mismatch", () => {
    expect(
      validateWhatsAppOutboundAuthorization(ownerPermit(), {
        to: "other@g.us",
        channel: "whatsapp",
        now,
      }),
    ).toEqual({ status: "denied", reasonCode: "destination_mismatch" });
  });

  it("denies wrong channel", () => {
    expect(
      validateWhatsAppOutboundAuthorization(ownerPermit(), {
        to: GROUP,
        channel: "telegram",
        now,
      }),
    ).toEqual({ status: "denied", reasonCode: "wrong_channel" });
  });

  it("denies group permit for a direct chat destination", () => {
    expect(
      validateWhatsAppOutboundAuthorization(ownerPermit(), {
        to: "+84938030977@c.us",
        channel: "whatsapp",
        now,
      }),
    ).toEqual({ status: "denied", reasonCode: "not_group" });
  });

  it("authorizes owner_explicit_send structurally for the exact destination", () => {
    const decision = validateWhatsAppOutboundAuthorization(ownerPermit(), {
      to: GROUP,
      channel: "whatsapp",
      now,
    });
    expect(decision.status).toBe("authorized");
  });

  it("authorizes delegated_group_reply structurally only with delegated specifics", () => {
    expect(
      validateWhatsAppOutboundAuthorization(delegatedPermit(), {
        to: GROUP,
        channel: "whatsapp",
        now,
      }).status,
    ).toBe("authorized");
    expect(
      validateWhatsAppOutboundAuthorization(delegatedPermit({ quotedMessageId: undefined }), {
        to: GROUP,
        channel: "whatsapp",
        now,
      }),
    ).toEqual({ status: "denied", reasonCode: "malformed_permit" });
  });
});

describe("trusted permit registry + atomic one-shot claim", () => {
  it("denies a forged permit that was never registered", () => {
    expect(claim(ownerPermit())).toEqual({ status: "denied", reasonCode: "unknown_authorization" });
  });

  it("authorizes a registered owner_explicit_send permit exactly once", () => {
    const p = ownerPermit();
    registerWhatsAppOutboundAuthorization(p);
    expect(claim(p)).toMatchObject({ status: "authorized", token: p.token });
    expect(claim(p)).toEqual({ status: "denied", reasonCode: "consumed_permit" });
  });

  it("two concurrent claims on one registered permit yield at most one authorized", async () => {
    const p = ownerPermit();
    registerWhatsAppOutboundAuthorization(p);
    const attempts = await Promise.all(
      Array.from({ length: 2 }, () => Promise.resolve().then(() => claim(p))),
    );
    const authorized = attempts.filter((decision) => decision.status === "authorized");
    expect(authorized).toHaveLength(1);
    expect(attempts.filter((decision) => decision.status === "denied")).toHaveLength(1);
  });

  it("denies a mismatched originating request/run", () => {
    const p = ownerPermit();
    registerWhatsAppOutboundAuthorization(p);
    expect(claim(p, GROUP, "another-run-event")).toEqual({
      status: "denied",
      reasonCode: "origin_mismatch",
    });
  });

  it("denies missing origin identity at claim time", () => {
    const p = ownerPermit();
    registerWhatsAppOutboundAuthorization(p);
    expect(claim(p, GROUP, "")).toEqual({
      status: "denied",
      reasonCode: "missing_origin",
    });
  });

  it("never evicts an unexpired registered permit while sweeping expired permits", () => {
    const live = ownerPermit();
    const expired = ownerPermit({
      token: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      createdAt: now - 600_000,
      expiresAt: now - 1,
    });
    registerWhatsAppOutboundAuthorization(live);
    registerWhatsAppOutboundAuthorization(expired);
    expect(claim(live)).toMatchObject({ status: "authorized" });
  });

  it("denies wrong destination at claim time", () => {
    const p = ownerPermit();
    registerWhatsAppOutboundAuthorization(p);
    expect(claim(p, "other@g.us")).toEqual({
      status: "denied",
      reasonCode: "destination_mismatch",
    });
  });

  it("denies expired permit at claim time", () => {
    const p = ownerPermit({ createdAt: now - 600_000, expiresAt: now - 1 });
    registerWhatsAppOutboundAuthorization(p);
    expect(claim(p)).toEqual({ status: "denied", reasonCode: "expired_permit" });
  });

  it("returns not_required for direct and non-whatsapp destinations", () => {
    expect(
      claimWhatsAppOutboundAuthorizationForTransport({
        to: "+84938030977@c.us",
        channel: "whatsapp",
        authorization: undefined,
        now,
      }),
    ).toEqual({ status: "not_required" });
    expect(
      claimWhatsAppOutboundAuthorizationForTransport({
        to: GROUP,
        channel: "telegram",
        authorization: undefined,
        now,
      }),
    ).toEqual({ status: "not_required" });
  });
});
