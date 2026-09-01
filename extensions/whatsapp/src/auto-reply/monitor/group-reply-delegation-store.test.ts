// Whatsapp tests cover the durable GroupReplyDelegation store contract.
import { beforeEach, describe, expect, it } from "vitest";
import {
  createKeyedGroupReplyDelegationStore,
  createMemoryGroupReplyDelegationStore,
  GROUP_REPLY_TRIGGER_VERSION,
  type GroupReplyDelegationStore,
} from "./group-reply-delegation-store.js";
import type { GroupReplyOnceAuthorization } from "./group-reply-delegation.types.js";

const NOW = 1_000;
const TTL = 120_000;

function makeDelegation(
  overrides: Partial<GroupReplyOnceAuthorization> = {},
): GroupReplyOnceAuthorization {
  return {
    token: "token-1",
    delegationId: "delegation-1",
    sourceEventId: "source-1",
    triggerVersion: GROUP_REPLY_TRIGGER_VERSION,
    groupId: "group@g.us",
    chatId: "group@g.us",
    quotedMessageId: "quoted-1",
    quotedBody: "original",
    target: { participantId: "target-1" },
    ownerTriggerMessageId: "trigger-1",
    ownerSenderId: "+15550000001",
    createdAt: NOW,
    expiresAt: NOW + TTL,
    maxSends: 1,
    consumed: false,
    ...overrides,
  };
}

type MapStore = {
  values: Map<string, GroupReplyOnceAuthorization>;
};

function createMapBackedStore(values: Map<string, GroupReplyOnceAuthorization>) {
  return {
    lookup(key: string) {
      return values.get(key);
    },
    registerIfAbsent(key: string, value: GroupReplyOnceAuthorization) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    update(
      key: string,
      updateValue: (
        current: GroupReplyOnceAuthorization | undefined,
      ) => GroupReplyOnceAuthorization | undefined,
    ) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
  };
}

function createMapStore(
  values = new Map<string, GroupReplyOnceAuthorization>(),
): GroupReplyDelegationStore {
  return createKeyedGroupReplyDelegationStore(createMapBackedStore(values));
}

describe("createMemoryGroupReplyDelegationStore", () => {
  let store: GroupReplyDelegationStore;

  beforeEach(() => {
    store = createMemoryGroupReplyDelegationStore();
  });

  it("persists and reads a pending delegation by source event id", () => {
    const delegation = makeDelegation();
    expect(store.createIfAbsent(delegation.sourceEventId, delegation)).toBe(true);
    expect(store.findBySourceEventId(delegation.sourceEventId)).toEqual(delegation);
  });

  it("rejects a duplicate source event", () => {
    const delegation = makeDelegation();
    store.createIfAbsent(delegation.sourceEventId, delegation);
    expect(
      store.createIfAbsent(delegation.sourceEventId, makeDelegation({ token: "token-2" })),
    ).toBe(false);
  });

  it("claims a pending delegation exactly once", () => {
    const delegation = makeDelegation();
    store.createIfAbsent(delegation.sourceEventId, delegation);
    expect(store.claim(delegation.sourceEventId, NOW + 1)).toMatchObject({
      status: "authorized",
      authorization: { consumed: true, consumedAt: NOW + 1 },
    });
    expect(store.claim(delegation.sourceEventId, NOW + 2)).toMatchObject({
      status: "denied",
      reason: "already_consumed",
    });
  });

  it("fails closed for an expired delegation", () => {
    const delegation = makeDelegation();
    store.createIfAbsent(delegation.sourceEventId, delegation);
    expect(store.claim(delegation.sourceEventId, delegation.expiresAt + 1)).toMatchObject({
      status: "denied",
      reason: "expired",
    });
  });
});

describe("createKeyedGroupReplyDelegationStore", () => {
  it("survives restart while retaining consumed state", () => {
    const durable = new Map<string, GroupReplyOnceAuthorization>();
    const first = createMapStore(durable);
    const delegation = makeDelegation();
    first.createIfAbsent(delegation.sourceEventId, delegation);

    const afterRestart = createMapStore(durable);
    expect(afterRestart.findBySourceEventId(delegation.sourceEventId)).toEqual(delegation);
    expect(afterRestart.claim(delegation.sourceEventId, NOW + 1)).toMatchObject({
      status: "authorized",
      authorization: { consumed: true },
    });

    const secondRestart = createMapStore(durable);
    expect(secondRestart.claim(delegation.sourceEventId, NOW + 2)).toMatchObject({
      status: "denied",
      reason: "already_consumed",
    });
  });

  it("does not mint a second delegation for the same source event", () => {
    const durable = new Map<string, GroupReplyOnceAuthorization>();
    const store = createMapStore(durable);
    const delegation = makeDelegation();
    expect(store.createIfAbsent(delegation.sourceEventId, delegation)).toBe(true);
    expect(
      store.createIfAbsent(delegation.sourceEventId, makeDelegation({ token: "token-2" })),
    ).toBe(false);
    expect(store.findBySourceEventId(delegation.sourceEventId)?.delegationId).toBe(
      delegation.delegationId,
    );
  });
});
