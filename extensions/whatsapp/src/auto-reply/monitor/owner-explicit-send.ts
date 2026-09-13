// WhatsApp plugin implements trusted owner_explicit_send authorization v0.1.
//
// An owner DM may explicitly direct an outbound group send ("Send this to X",
// "Ask X ...", "Message X ..."). This module derives a destination-bound,
// single-use, short-lived permit from that ACTUAL trusted owner request.
//
// The LLM can never mint this permit: minting runs in channel feature code
// only, uses only the trusted owner identity plus the literal owner message,
// and fails closed on any ambiguity (unknown destination, non-owner, expired,
// or a non-send phrasing such as "Check who is playing").
//
// Single-use consumption is owned by the core trusted transport registry
// (`registerWhatsAppOutboundAuthorization` / `claimWhatsAppOutboundAuthorizationForTransport`),
// which is the single authoritative state for permission to send. This module
// keeps only the trusted mint + collision registry.
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerWhatsAppOutboundAuthorization } from "openclaw/plugin-sdk/whatsapp-outbound-authorization-registration";
import { resolveMergedWhatsAppAccountConfig } from "../../account-config.js";
import { getSelfIdentity, getSenderIdentity } from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import { resolveWhatsAppInboundEventIdentity } from "../../inbound/inbound-event-identity.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { getOptionalWhatsAppRuntime } from "../../runtime.js";
import { normalizeE164 } from "../../text-runtime.js";
import type { MentionConfig } from "../mentions.js";
import { resolveOwnerList } from "../mentions.js";

export const OWNER_EXPLICIT_SEND_TTL_MS = 300_000; // 5 minutes, fail closed
export const OWNER_EXPLICIT_SEND_POLICY_VERSION = 1 as const;

export type OwnerExplicitSendAuthorization = {
  authorizationClass: "owner_explicit_send";
  policyVersion: typeof OWNER_EXPLICIT_SEND_POLICY_VERSION;
  actionType: "whatsapp.group.send";
  token: string;
  ownerE164: string;
  groupId: string;
  chatId: string;
  createdAt: number;
  expiresAt: number;
  maxSends: 1;
  sourceEventId: string;
};

export type OwnerExplicitSendResult =
  | { status: "not_explicit_send" }
  | { status: "authorized"; authorization: OwnerExplicitSendAuthorization }
  | { status: "denied"; reason: string };

export type OwnerExplicitSendStore = {
  createIfAbsent(token: string, authorization: OwnerExplicitSendAuthorization): boolean;
  resetForTests(): void;
};

const SEND_DIRECTIVE_RE =
  /^(?:send\s+(?:this|a\s+message|the\s+following|message|text)|(?:ask|message|tell|text|dm|contact)\s+)\s*/i;

/** Extract a literal destination string that appears after an explicit send verb. */
function extractSendDirective(body: string): { destination: string; instruction: string } | null {
  const trimmed = body.trim();
  if (!SEND_DIRECTIVE_RE.test(trimmed)) {
    return null;
  }

  // "send this message to <dest>: rest" / "send this to <dest>: rest" /
  // "send a message to <dest> rest" / "ask <dest> rest"
  const match =
    /^(?:send(?:\s+this(?:\s+message)?|\s+a\s+message|\s+the\s+following)?(?:\s+to)?|ask|message|tell|text|dm|contact)\s+(.+)$/i.exec(
      trimmed,
    );
  if (!match) {
    return null;
  }

  const rest = (match[1] ?? "").trim();
  // Destination is the longest prefix ending at a separator (":", ":", newline,
  // or the words "who is", "about", "that", "whether") — keep this narrow to
  // avoid treating a long free-text question as a destination.
  const sep = rest.search(/\s*[:：]\s*/);
  const destination =
    sep >= 0 ? rest.slice(0, sep).trim() : rest.split(/\s+/).slice(0, 4).join(" ").trim();
  const instruction =
    sep >= 0
      ? rest
          .slice(sep)
          .replace(/^\s*[:：]\s*/, "")
          .trim()
      : "";

  if (destination.length === 0) {
    return null;
  }
  return { destination, instruction };
}

function resolveOwnerE164s(
  msg: AdmittedWebInboundMessage,
  baseMentionConfig: MentionConfig,
  authDir?: string,
): string[] {
  return resolveOwnerList(baseMentionConfig, getSelfIdentity(msg, authDir).e164 ?? undefined);
}

function senderE164(msg: AdmittedWebInboundMessage, authDir?: string): string | undefined {
  const e164 = normalizeE164(getSenderIdentity(msg, authDir).e164 ?? "");
  return e164 || undefined;
}

/** Resolve a destination group JID from the literal owner instruction. */
export function resolveExplicitSendDestination(
  destination: string,
  cfg: OpenClawConfig,
  accountId?: string,
): string | null {
  const trimmed = destination.trim();
  if (/@g\.us$/i.test(trimmed)) {
    return trimmed;
  }

  const account = resolveMergedWhatsAppAccountConfig({ cfg, accountId });
  const groups = account.groups;
  if (!groups || typeof groups !== "object") {
    return null;
  }
  for (const [key, value] of Object.entries(groups)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    if (trimmed === key) {
      return key;
    }
    const name = typeof value.name === "string" ? value.name.trim() : "";
    if (name.length > 0 && name.toLowerCase() === trimmed.toLowerCase()) {
      return key;
    }
  }
  return null;
}

export function authorizeOwnerExplicitSend(
  params: {
    cfg: OpenClawConfig;
    msg: AdmittedWebInboundMessage;
    baseMentionConfig: MentionConfig;
    authDir?: string;
    accountId?: string;
  },
  runtime: { now: () => number; createToken: () => string } = {
    now: () => Date.now(),
    createToken: () => randomUUID(),
  },
): OwnerExplicitSendResult {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  if (admission.conversation.kind !== "direct") {
    return { status: "not_explicit_send" };
  }

  const ownerE164 = senderE164(params.msg, params.authDir);
  if (!ownerE164) {
    return { status: "denied", reason: "missing_owner_identity" };
  }
  const owners = resolveOwnerE164s(params.msg, params.baseMentionConfig, params.authDir);
  if (!owners.includes(ownerE164)) {
    return { status: "denied", reason: "not_owner" };
  }

  const body = params.msg.payload.commandBody ?? params.msg.payload.body;
  if (typeof body !== "string") {
    return { status: "not_explicit_send" };
  }
  const directive = extractSendDirective(body);
  if (!directive) {
    return { status: "not_explicit_send" };
  }

  const groupId = resolveExplicitSendDestination(
    directive.destination,
    params.cfg,
    params.accountId,
  );
  if (!groupId) {
    return { status: "denied", reason: "unknown_destination" };
  }

  const identity = resolveWhatsAppInboundEventIdentity(params.msg);
  if (identity.status !== "resolved") {
    return { status: "denied", reason: `unstable_source_event_identity:${identity.reason}` };
  }

  const now = runtime.now();
  const token = runtime.createToken();
  const authorization: OwnerExplicitSendAuthorization = {
    authorizationClass: "owner_explicit_send",
    policyVersion: OWNER_EXPLICIT_SEND_POLICY_VERSION,
    actionType: "whatsapp.group.send",
    token,
    ownerE164,
    groupId,
    chatId: groupId,
    createdAt: now,
    expiresAt: now + OWNER_EXPLICIT_SEND_TTL_MS,
    maxSends: 1,
    sourceEventId: identity.sourceEventId,
  };

  const store = resolveOwnerExplicitSendStore();
  const created = store.createIfAbsent(token, authorization);
  if (!created) {
    return { status: "denied", reason: "token_collision" };
  }
  registerWhatsAppOutboundAuthorization(authorization);
  return { status: "authorized", authorization };
}

type KeyedStoreLike = {
  registerIfAbsent(
    key: string,
    value: OwnerExplicitSendAuthorization,
    opts?: { ttlMs?: number },
  ): boolean;
  clear?: () => void;
};

const OWNER_EXPLICIT_SEND_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OWNER_EXPLICIT_SEND_MAX_ENTRIES = 450;

function createMemoryOwnerExplicitSendStore(): OwnerExplicitSendStore {
  const byToken = new Map<string, OwnerExplicitSendAuthorization>();
  return {
    createIfAbsent(token, authorization) {
      if (byToken.has(token)) {
        return false;
      }
      byToken.set(token, authorization);
      return true;
    },
    resetForTests() {
      byToken.clear();
    },
  };
}

function createKeyedOwnerExplicitSendStore(store: KeyedStoreLike): OwnerExplicitSendStore {
  return {
    createIfAbsent(token, authorization) {
      return store.registerIfAbsent(token, authorization, {
        ttlMs: OWNER_EXPLICIT_SEND_RETENTION_MS,
      });
    },
    resetForTests() {
      store.clear?.();
    },
  };
}

let runtimeStore: OwnerExplicitSendStore | undefined;
let memoryStore: OwnerExplicitSendStore | undefined;

export function resolveOwnerExplicitSendStore(): OwnerExplicitSendStore {
  const runtime = getOptionalWhatsAppRuntime();
  if (runtime) {
    runtimeStore ??= createKeyedOwnerExplicitSendStore(
      runtime.state.openSyncKeyedStore<OwnerExplicitSendAuthorization>({
        namespace: "whatsapp_owner_explicit_send",
        maxEntries: OWNER_EXPLICIT_SEND_MAX_ENTRIES,
        defaultTtlMs: OWNER_EXPLICIT_SEND_RETENTION_MS,
        overflowPolicy: "evict-oldest",
      }),
    );
    return runtimeStore;
  }
  memoryStore ??= createMemoryOwnerExplicitSendStore();
  return memoryStore;
}

export function resetOwnerExplicitSendStoreForTests(): void {
  runtimeStore?.resetForTests();
  runtimeStore = undefined;
  memoryStore?.resetForTests();
  memoryStore = undefined;
}
