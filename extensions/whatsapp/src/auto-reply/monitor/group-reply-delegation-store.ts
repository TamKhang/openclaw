// Whatsapp plugin module implements the durable GroupReplyDelegation store.
// The current-process Maps in group-reply-once are replaced by this bounded
// store so pending/consumed authority survives a gateway restart.
import { getOptionalWhatsAppRuntime } from "../../runtime.js";
import type { GroupReplyOnceAuthorization } from "./group-reply-delegation.types.js";

export const GROUP_REPLY_TRIGGER_VERSION = "owner_group_reply_trigger:v0.1";
export const GROUP_REPLY_DELEGATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const GROUP_REPLY_DELEGATION_MAX_ENTRIES = 450;

export type GroupReplyDelegationClaimResult =
  | { status: "authorized"; authorization: GroupReplyOnceAuthorization }
  | { status: "denied"; reason: "no_authorization" | "already_consumed" | "expired" };

export type GroupReplyDelegationStore = {
  findBySourceEventId(sourceEventId: string): GroupReplyOnceAuthorization | undefined;
  createIfAbsent(sourceEventId: string, delegation: GroupReplyOnceAuthorization): boolean;
  claim(sourceEventId: string, now: number): GroupReplyDelegationClaimResult;
  resetForTests(): void;
};

type KeyedStoreLike = {
  lookup(key: string): GroupReplyOnceAuthorization | undefined;
  registerIfAbsent(
    key: string,
    value: GroupReplyOnceAuthorization,
    opts?: { ttlMs?: number },
  ): boolean;
  update?: (
    key: string,
    updateValue: (
      current: GroupReplyOnceAuthorization | undefined,
    ) => GroupReplyOnceAuthorization | undefined,
    opts?: { ttlMs?: number },
  ) => boolean;
  clear?: () => void;
};

export function createMemoryGroupReplyDelegationStore(): GroupReplyDelegationStore {
  const bySourceEventId = new Map<string, GroupReplyOnceAuthorization>();
  return {
    findBySourceEventId(sourceEventId) {
      return bySourceEventId.get(sourceEventId);
    },
    createIfAbsent(sourceEventId, delegation) {
      if (bySourceEventId.has(sourceEventId)) {
        return false;
      }
      bySourceEventId.set(sourceEventId, delegation);
      return true;
    },
    claim(sourceEventId, now) {
      const existing = bySourceEventId.get(sourceEventId);
      if (!existing) {
        return { status: "denied", reason: "no_authorization" };
      }
      if (existing.consumed) {
        return { status: "denied", reason: "already_consumed" };
      }
      if (now >= existing.expiresAt) {
        return { status: "denied", reason: "expired" };
      }
      const consumed: GroupReplyOnceAuthorization = {
        ...existing,
        consumed: true,
        consumedAt: now,
      };
      bySourceEventId.set(sourceEventId, consumed);
      return { status: "authorized", authorization: consumed };
    },
    resetForTests() {
      bySourceEventId.clear();
    },
  };
}

export function createKeyedGroupReplyDelegationStore(
  store: KeyedStoreLike,
): GroupReplyDelegationStore {
  return {
    findBySourceEventId(sourceEventId) {
      return store.lookup(sourceEventId);
    },
    createIfAbsent(sourceEventId, delegation) {
      return store.registerIfAbsent(sourceEventId, delegation, {
        ttlMs: GROUP_REPLY_DELEGATION_RETENTION_MS,
      });
    },
    claim(sourceEventId, now) {
      const update = store.update;
      if (!update) {
        return { status: "denied", reason: "no_authorization" };
      }
      let outcome: GroupReplyDelegationClaimResult = {
        status: "denied",
        reason: "no_authorization",
      };
      update(sourceEventId, (current) => {
        if (!current) {
          outcome = { status: "denied", reason: "no_authorization" };
          return undefined;
        }
        if (current.consumed) {
          outcome = { status: "denied", reason: "already_consumed" };
          return undefined;
        }
        if (now >= current.expiresAt) {
          outcome = { status: "denied", reason: "expired" };
          return undefined;
        }
        const consumed: GroupReplyOnceAuthorization = {
          ...current,
          consumed: true,
          consumedAt: now,
        };
        outcome = { status: "authorized", authorization: consumed };
        return consumed;
      });
      return outcome;
    },
    resetForTests() {
      store.clear?.();
    },
  };
}

let runtimeDelegationStore: GroupReplyDelegationStore | undefined;
let memoryDelegationStore: GroupReplyDelegationStore | undefined;

export function resolveGroupReplyDelegationStore(): GroupReplyDelegationStore {
  const runtime = getOptionalWhatsAppRuntime();
  if (runtime) {
    runtimeDelegationStore ??= createKeyedGroupReplyDelegationStore(
      runtime.state.openSyncKeyedStore<GroupReplyOnceAuthorization>({
        namespace: "whatsapp_group_reply_delegations",
        maxEntries: GROUP_REPLY_DELEGATION_MAX_ENTRIES,
        defaultTtlMs: GROUP_REPLY_DELEGATION_RETENTION_MS,
        overflowPolicy: "evict-oldest",
      }),
    );
    return runtimeDelegationStore;
  }
  memoryDelegationStore ??= createMemoryGroupReplyDelegationStore();
  return memoryDelegationStore;
}

export function resetGroupReplyDelegationStoreForTests(): void {
  runtimeDelegationStore?.resetForTests();
  runtimeDelegationStore = undefined;
  memoryDelegationStore?.resetForTests();
  memoryDelegationStore = undefined;
}
