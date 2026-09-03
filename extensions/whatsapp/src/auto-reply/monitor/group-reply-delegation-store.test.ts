import { describe, expect, it } from "vitest";
import { createMemoryGroupReplyDelegationStore } from "./group-reply-delegation-store.js";
import type { GroupReplyOnceAuthorization } from "./group-reply-delegation.types.js";

function makeDelegation(): GroupReplyOnceAuthorization {
  return {
    token: "token",
    delegationId: "token",
    sourceEventId: "source",
    triggerVersion: "owner_group_reply_trigger:v0.1",
    groupId: "group@g.us",
    chatId: "group@g.us",
    quotedMessageId: "quoted",
    quotedBody: "body",
    target: { participantId: "+15550000002" },
    ownerTriggerMessageId: "trigger",
    ownerSenderId: "+15550000001",
    createdAt: 1,
    expiresAt: 1_000,
    maxSends: 1,
    consumed: false,
  };
}

describe("group reply delegation store", () => {
  it("creates once and claims once", () => {
    const store = createMemoryGroupReplyDelegationStore();
    expect(store.createIfAbsent("source", makeDelegation())).toBe(true);
    expect(store.createIfAbsent("source", makeDelegation())).toBe(false);
    expect(store.claim("source", 2)).toMatchObject({ status: "authorized" });
    expect(store.claim("source", 2)).toMatchObject({
      status: "denied",
      reason: "already_consumed",
    });
  });

  it("denies expired claims", () => {
    const store = createMemoryGroupReplyDelegationStore();
    store.createIfAbsent("source", makeDelegation());
    expect(store.claim("source", 1_000)).toMatchObject({ status: "denied", reason: "expired" });
  });
});
