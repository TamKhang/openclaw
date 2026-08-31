// Whatsapp plugin module implements explicit owner-delegated group reply v0.1.
//
// The trigger is exact and case/punctuation-sensitive: `Bruno, come in`.
// A successful trigger creates a single-use, short-lived authorization bound
// to the exact group, quoted message, owner trigger message, and querying
// participant. Answer generation never grants send authority; only the
// WhatsApp outbound delivery guard consumes the authorization.
import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  getPrimaryIdentityId,
  getReplyContext,
  getSelfIdentity,
  getSenderIdentity,
  type WhatsAppIdentity,
} from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { normalizeE164 } from "../../text-runtime.js";
import type { MentionConfig } from "../mentions.js";
import { resolveOwnerList } from "../mentions.js";

export const EXPLICIT_OWNER_GROUP_REPLY_TRIGGER = "Bruno, come in";
export const GROUP_REPLY_ONCE_TTL_MS = 30_000;

export type GroupReplyOnceTarget = {
  participantId: string;
  displayName?: string;
  e164?: string;
  jid?: string;
};

export type GroupReplyOnceAuthorization = {
  token: string;
  groupId: string;
  chatId: string;
  quotedMessageId: string;
  quotedBody: string;
  target: GroupReplyOnceTarget;
  ownerTriggerMessageId: string;
  ownerSenderId: string;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
};

export type GroupReplyOnceAuthorizeResult =
  | { status: "not_trigger" }
  | { status: "authorized"; authorization: GroupReplyOnceAuthorization }
  | { status: "denied"; reason: string };

export type GroupReplyOnceConsumeResult =
  | { status: "authorized"; authorization: GroupReplyOnceAuthorization }
  | { status: "denied"; reason: string };

export type GroupReplyOnceRuntime = {
  now: () => number;
  createToken: () => string;
};

const defaultGroupReplyOnceRuntime: GroupReplyOnceRuntime = {
  now: () => Date.now(),
  createToken: () => randomUUID(),
};

const authorizationsByToken = new Map<string, GroupReplyOnceAuthorization>();
const tokenByTriggerMessageId = new Map<string, string>();

export function resetGroupReplyOnceForTests() {
  authorizationsByToken.clear();
  tokenByTriggerMessageId.clear();
}

function resolveOwnerE164s(
  msg: AdmittedWebInboundMessage,
  baseMentionConfig: MentionConfig,
  authDir?: string,
): string[] {
  return resolveOwnerList(baseMentionConfig, getSelfIdentity(msg, authDir).e164 ?? undefined);
}

function resolveOwnerSenderE164(
  msg: AdmittedWebInboundMessage,
  authDir?: string,
): string | undefined {
  const sender = normalizeE164(getSenderIdentity(msg, authDir).e164 ?? "");
  return sender || undefined;
}

function readNonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveQuotedTarget(
  msg: AdmittedWebInboundMessage,
  authDir?: string,
):
  | {
      quotedMessageId: string;
      quotedBody: string;
      participantId: string;
      sender: WhatsAppIdentity | null;
    }
  | { error: string } {
  const replyContext = getReplyContext(msg, authDir);
  if (!replyContext?.id) {
    return { error: "missing_quoted_message_id" };
  }
  const participantId = getPrimaryIdentityId(replyContext.sender) ?? undefined;
  if (!participantId) {
    return { error: "missing_quoted_sender" };
  }
  return {
    quotedMessageId: replyContext.id,
    quotedBody: replyContext.body,
    participantId,
    sender: replyContext.sender ?? null,
  };
}

function resolveTargetDisplayName(params: {
  msg: AdmittedWebInboundMessage;
  authDir?: string;
  groupHistoryKey: string;
  groupMemberNames: Map<string, Map<string, string>>;
  participantId: string;
  sender: WhatsAppIdentity | null;
}): string | undefined {
  const roster = params.groupMemberNames.get(params.groupHistoryKey);
  const candidates = [
    params.sender?.name,
    params.sender?.label,
    params.msg.quote?.sender?.displayName,
    roster?.get(params.participantId),
    params.sender?.e164 ? roster?.get(params.sender.e164) : undefined,
    params.sender?.jid ? roster?.get(params.sender.jid) : undefined,
    params.sender?.lid ? roster?.get(params.sender.lid) : undefined,
  ];
  for (const candidate of candidates) {
    const value = readNonBlankString(candidate);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function authorizeExplicitOwnerGroupReply(
  params: {
    cfg: OpenClawConfig;
    msg: AdmittedWebInboundMessage;
    baseMentionConfig: MentionConfig;
    authDir?: string;
    groupHistoryKey: string;
    groupMemberNames: Map<string, Map<string, string>>;
  },
  runtime: GroupReplyOnceRuntime = defaultGroupReplyOnceRuntime,
): GroupReplyOnceAuthorizeResult {
  const body = params.msg.payload.commandBody ?? params.msg.payload.body;
  if (body !== EXPLICIT_OWNER_GROUP_REPLY_TRIGGER) {
    return { status: "not_trigger" };
  }

  const admission = requireWhatsAppInboundAdmission(params.msg);
  if (admission.conversation.kind !== "group") {
    return { status: "denied", reason: "not_group" };
  }
  const ownerTriggerMessageId = params.msg.event.id;
  if (!ownerTriggerMessageId) {
    return { status: "denied", reason: "missing_trigger_message_id" };
  }
  if (tokenByTriggerMessageId.has(ownerTriggerMessageId)) {
    return { status: "denied", reason: "replay_trigger_message" };
  }

  const ownerSenderId = resolveOwnerSenderE164(params.msg, params.authDir);
  if (!ownerSenderId) {
    return { status: "denied", reason: "missing_owner_identity" };
  }
  const owners = resolveOwnerE164s(params.msg, params.baseMentionConfig, params.authDir);
  if (!owners.includes(ownerSenderId)) {
    return { status: "denied", reason: "not_owner" };
  }

  const quoted = resolveQuotedTarget(params.msg, params.authDir);
  if ("error" in quoted) {
    return { status: "denied", reason: quoted.error };
  }

  const groupId = admission.conversation.id;
  const chatId = params.msg.platform.chatJid || groupId;
  const now = runtime.now();
  const token = runtime.createToken();
  const targetDisplayName = resolveTargetDisplayName({
    msg: params.msg,
    authDir: params.authDir,
    groupHistoryKey: params.groupHistoryKey,
    groupMemberNames: params.groupMemberNames,
    participantId: quoted.participantId,
    sender: quoted.sender,
  });
  const authorization: GroupReplyOnceAuthorization = {
    token,
    groupId,
    chatId,
    quotedMessageId: quoted.quotedMessageId,
    quotedBody: quoted.quotedBody,
    target: {
      participantId: quoted.participantId,
      ...(targetDisplayName ? { displayName: targetDisplayName } : {}),
      ...(quoted.sender?.e164 ? { e164: quoted.sender.e164 } : {}),
      ...(quoted.sender?.jid ? { jid: quoted.sender.jid } : {}),
    },
    ownerTriggerMessageId,
    ownerSenderId,
    createdAt: now,
    expiresAt: now + GROUP_REPLY_ONCE_TTL_MS,
    consumed: false,
  };

  authorizationsByToken.set(token, authorization);
  tokenByTriggerMessageId.set(ownerTriggerMessageId, token);
  params.msg.groupReplyOnce = authorization;
  return { status: "authorized", authorization };
}

export function consumeGroupReplyOnceAuthorization(
  params: {
    msg: AdmittedWebInboundMessage;
    authDir?: string;
  },
  runtime: Pick<GroupReplyOnceRuntime, "now"> = defaultGroupReplyOnceRuntime,
): GroupReplyOnceConsumeResult {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  const ownerTriggerMessageId = params.msg.event.id;
  const token =
    params.msg.groupReplyOnce?.token ??
    (ownerTriggerMessageId ? tokenByTriggerMessageId.get(ownerTriggerMessageId) : undefined);
  if (!token) {
    return { status: "denied", reason: "no_authorization" };
  }
  const authorization = authorizationsByToken.get(token);
  if (!authorization) {
    return { status: "denied", reason: "no_authorization" };
  }
  if (authorization.consumed) {
    return { status: "denied", reason: "already_consumed" };
  }
  if (runtime.now() >= authorization.expiresAt) {
    return { status: "denied", reason: "expired" };
  }
  if (authorization.groupId !== admission.conversation.id) {
    return { status: "denied", reason: "group_mismatch" };
  }
  if (authorization.ownerTriggerMessageId !== ownerTriggerMessageId) {
    return { status: "denied", reason: "trigger_mismatch" };
  }
  const currentOwnerSenderId = resolveOwnerSenderE164(params.msg, params.authDir);
  if (!currentOwnerSenderId || currentOwnerSenderId !== authorization.ownerSenderId) {
    return { status: "denied", reason: "owner_mismatch" };
  }
  if (authorization.chatId !== (params.msg.platform.chatJid || admission.conversation.id)) {
    return { status: "denied", reason: "chat_mismatch" };
  }
  const quoted = resolveQuotedTarget(params.msg, params.authDir);
  if ("error" in quoted) {
    return { status: "denied", reason: `quoted_target_${quoted.error}` };
  }
  if (
    quoted.quotedMessageId !== authorization.quotedMessageId ||
    quoted.participantId !== authorization.target.participantId
  ) {
    return { status: "denied", reason: "quoted_target_mismatch" };
  }

  authorization.consumed = true;
  return { status: "authorized", authorization };
}
