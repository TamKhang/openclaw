// Central WhatsApp outbound authorization contract and transport-level gate.
//
// This module owns the trusted, fail-closed boundary for WhatsApp GROUP
// outbound delivery. The LLM can request an outbound action but can never
// authorize itself: permits are minted exclusively by trusted channel feature
// code (see extensions/whatsapp/src/auto-reply/monitor/group-reply-once.ts and
// owner-explicit-send.ts) from actual trusted owner state, never from message
// text, prompt text, quoted content, or model output.
//
// The same permit shape is projected onto the `message_sending` plugin hook
// (as `outboundGroupReplyAuthorization`) and onto the final transport gate in
// `deliver-core.ts`. The transport gate does NOT trust a structurally valid
// object by itself: trusted minting code must first register the permit via
// `registerWhatsAppOutboundAuthorization`, and transport claims it atomically
// with `claimWhatsAppOutboundAuthorizationForTransport`.

export const WHATSAPP_OUTBOUND_AUTHORIZATION_POLICY_VERSION = 1 as const;

export type WhatsAppOutboundAuthorizationClass = "owner_explicit_send" | "delegated_group_reply";

/** WhatsApp group send action types admitted by the gate. */
export const WHATSAPP_GROUP_SEND_ACTION_TYPE = "whatsapp.group.send" as const;

/** Authorized capability discriminator for owner-delegated group replies. */
export const WHATSAPP_GROUP_REPLY_ONCE_CAPABILITY = "whatsapp.group.reply_once" as const;

/**
 * Trusted, single-use WhatsApp group outbound permit.
 *
 * Field naming keeps `groupId` / `chatId` for compatibility with the existing
 * `outboundGroupReplyAuthorization` plumbing, but the permit now carries both
 * authorization classes.
 */
export type WhatsAppOutboundAuthorization = {
  authorizationClass: WhatsAppOutboundAuthorizationClass;
  policyVersion: typeof WHATSAPP_OUTBOUND_AUTHORIZATION_POLICY_VERSION;
  /** Opaque random UUID v4 minted by trusted feature code. */
  token: string;
  /** Trusted owner E.164 identity that authorized the send. */
  ownerE164: string;
  /** Exact WhatsApp group JID the permit is bound to. */
  groupId: string;
  /** Provider chat JID used for delivery routing. */
  chatId: string;
  /** Exact action type this permit authorizes. */
  actionType: typeof WHATSAPP_GROUP_SEND_ACTION_TYPE;
  /** Trusted originating owner request identity that caused minting. */
  sourceEventId?: string;
  createdAt: number;
  expiresAt: number;
  maxSends: 1;
  /** delegated_group_reply specifics (absent for owner_explicit_send). */
  capability?: typeof WHATSAPP_GROUP_REPLY_ONCE_CAPABILITY;
  ownerTriggerMessageId?: string;
  quotedMessageId?: string;
  targetParticipantId?: string;
};

export type WhatsAppOutboundAuthorizationDenialReason =
  | "missing_permit"
  | "malformed_permit"
  | "unknown_authorization_class"
  | "invalid_token"
  | "expired_permit"
  | "consumed_permit"
  | "destination_mismatch"
  | "wrong_channel"
  | "not_group"
  | "unknown_authorization"
  | "missing_origin"
  | "origin_mismatch";

export type WhatsAppOutboundAuthorizationDecision =
  | {
      status: "authorized";
      authorizationClass: WhatsAppOutboundAuthorizationClass;
      token: string;
      destinationChatId: string;
    }
  | { status: "denied"; reasonCode: WhatsAppOutboundAuthorizationDenialReason };

export type WhatsAppOutboundTransportClaim =
  | {
      status: "authorized";
      authorizationClass: WhatsAppOutboundAuthorizationClass;
      token: string;
      destinationChatId: string;
    }
  | { status: "denied"; reasonCode: WhatsAppOutboundAuthorizationDenialReason }
  | { status: "not_required" };

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const WHATSAPP_GROUP_JID_RE = /@g\.us$/i;

export function isWhatsAppGroupDestination(to: string | undefined): boolean {
  return typeof to === "string" && WHATSAPP_GROUP_JID_RE.test(to.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Structural permit validation only. It proves the object has the right shape,
 * but it does NOT prove the object was minted by trusted owner authorization
 * logic. Transport must go through the trusted claim registry below.
 */
export function validateWhatsAppOutboundAuthorization(
  value: unknown,
  params: { to: string; channel: string; now?: number },
): WhatsAppOutboundAuthorizationDecision {
  if (params.channel !== "whatsapp") {
    return { status: "denied", reasonCode: "wrong_channel" };
  }

  const to = params.to.trim();
  if (!isWhatsAppGroupDestination(to)) {
    return { status: "denied", reasonCode: "not_group" };
  }

  if (!isRecord(value)) {
    return { status: "denied", reasonCode: "missing_permit" };
  }

  const authorizationClass = value.authorizationClass;
  if (
    authorizationClass !== "owner_explicit_send" &&
    authorizationClass !== "delegated_group_reply"
  ) {
    return { status: "denied", reasonCode: "unknown_authorization_class" };
  }
  if (value.policyVersion !== WHATSAPP_OUTBOUND_AUTHORIZATION_POLICY_VERSION) {
    return { status: "denied", reasonCode: "malformed_permit" };
  }
  const token = value.token;
  if (!nonEmptyString(token) || !UUID_V4_RE.test(token)) {
    return { status: "denied", reasonCode: "invalid_token" };
  }
  const ownerE164 = value.ownerE164;
  if (!nonEmptyString(ownerE164)) {
    return { status: "denied", reasonCode: "malformed_permit" };
  }
  const groupId = value.groupId;
  const chatId = value.chatId;
  if (!nonEmptyString(groupId) || !nonEmptyString(chatId)) {
    return { status: "denied", reasonCode: "malformed_permit" };
  }
  const sourceEventId = value.sourceEventId;
  if (!nonEmptyString(sourceEventId)) {
    return { status: "denied", reasonCode: "missing_origin" };
  }
  if (value.actionType !== WHATSAPP_GROUP_SEND_ACTION_TYPE) {
    return { status: "denied", reasonCode: "malformed_permit" };
  }
  const createdAt = value.createdAt;
  const expiresAt = value.expiresAt;
  const maxSends = value.maxSends;
  if (!finiteNumber(createdAt) || !finiteNumber(expiresAt) || maxSends !== 1) {
    return { status: "denied", reasonCode: "malformed_permit" };
  }

  const now = params.now ?? Date.now();
  if (now >= expiresAt) {
    return { status: "denied", reasonCode: "expired_permit" };
  }

  if (to !== chatId && to !== groupId) {
    return { status: "denied", reasonCode: "destination_mismatch" };
  }

  if (authorizationClass === "delegated_group_reply") {
    if (
      value.capability !== WHATSAPP_GROUP_REPLY_ONCE_CAPABILITY ||
      !nonEmptyString(value.ownerTriggerMessageId) ||
      !nonEmptyString(value.quotedMessageId) ||
      !nonEmptyString(value.targetParticipantId)
    ) {
      return { status: "denied", reasonCode: "malformed_permit" };
    }
  }

  return {
    status: "authorized",
    authorizationClass,
    token,
    destinationChatId: chatId,
  };
}

// ---------------------------------------------------------------------------
// Trusted permit registry + atomic one-shot claim
// ---------------------------------------------------------------------------
//
// A structurally valid object is NOT sufficient to pass transport. Trusted
// channel feature code must register a freshly minted permit before delivery.
// Claiming is atomic (synchronous check-and-mark, no await between check and
// consume) and happens before any transport transmission. A registered permit
// can be claimed exactly once; unregistered/forged/expired/wrong-destination
// permits fail closed.

type RegisteredWhatsAppAuthorization = {
  permit: WhatsAppOutboundAuthorization;
  consumed: boolean;
  consumedAt?: number;
};

const registeredWhatsAppAuthorizations = new Map<string, RegisteredWhatsAppAuthorization>();

export function registerWhatsAppOutboundAuthorization(permit: WhatsAppOutboundAuthorization): void {
  if (!permit || !permit.token || !UUID_V4_RE.test(permit.token)) {
    return;
  }
  const existing = registeredWhatsAppAuthorizations.get(permit.token);
  if (existing) {
    // First trusted registration wins; never overwrite an existing mint.
    return;
  }
  registeredWhatsAppAuthorizations.set(permit.token, {
    permit,
    consumed: false,
  });
  sweepExpiredRegisteredAuthorizations(Date.now());
}

function sweepExpiredRegisteredAuthorizations(now: number): void {
  for (const [token, entry] of registeredWhatsAppAuthorizations) {
    if (now >= entry.permit.expiresAt) {
      registeredWhatsAppAuthorizations.delete(token);
    }
  }
}

export function isWhatsAppAuthorizationRegistered(token: string): boolean {
  return registeredWhatsAppAuthorizations.has(token);
}

export function isWhatsAppAuthorizationTokenConsumed(token: string): boolean {
  return registeredWhatsAppAuthorizations.get(token)?.consumed === true;
}

/**
 * Atomic claim-before-transport. Returns `not_required` for non-WhatsApp or
 * direct destinations, `authorized` exactly once per registered permit, and a
 * fail-closed denial otherwise.
 */
export function claimWhatsAppOutboundAuthorizationForTransport(params: {
  to: string;
  channel: string;
  authorization?: unknown;
  now?: number;
  originEventId?: string;
}): WhatsAppOutboundTransportClaim {
  if (params.channel !== "whatsapp") {
    return { status: "not_required" };
  }
  const to = params.to.trim();
  if (!isWhatsAppGroupDestination(to)) {
    return { status: "not_required" };
  }

  const structural = validateWhatsAppOutboundAuthorization(params.authorization, {
    to,
    channel: params.channel,
    now: params.now,
  });
  if (structural.status === "denied") {
    return structural;
  }

  const now = params.now ?? Date.now();
  const token = structural.token;
  const entry = registeredWhatsAppAuthorizations.get(token);
  if (!entry) {
    return { status: "denied", reasonCode: "unknown_authorization" };
  }
  if (entry.consumed) {
    return { status: "denied", reasonCode: "consumed_permit" };
  }
  if (now >= entry.permit.expiresAt) {
    return { status: "denied", reasonCode: "expired_permit" };
  }
  if (to !== entry.permit.chatId && to !== entry.permit.groupId) {
    return { status: "denied", reasonCode: "destination_mismatch" };
  }

  // Trusted origin binding: the registered permit is bound to the exact owner
  // request/run that caused minting. Transport must carry the same trusted
  // origin, never a model-derived value.
  const permitOrigin = entry.permit.sourceEventId;
  if (!permitOrigin) {
    return { status: "denied", reasonCode: "missing_origin" };
  }
  if (!params.originEventId) {
    return { status: "denied", reasonCode: "missing_origin" };
  }
  if (permitOrigin !== params.originEventId) {
    return { status: "denied", reasonCode: "origin_mismatch" };
  }

  // Atomic one-shot consumption before any transport transmission.
  entry.consumed = true;
  entry.consumedAt = now;
  return {
    status: "authorized",
    authorizationClass: entry.permit.authorizationClass,
    token,
    destinationChatId: entry.permit.chatId,
  };
}

/**
 * Transport-level assertion invoked immediately before WhatsApp transport
 * transmission. Reaching WhatsApp transport for a group destination without a
 * registered, valid, unexpired, unconsumed, destination-matching permit is
 * denied.
 */
export function assertWhatsAppOutboundTransportAuthorized(params: {
  to: string;
  channel: string;
  authorization?: unknown;
  now?: number;
  originEventId?: string;
}): void {
  const decision = claimWhatsAppOutboundAuthorizationForTransport(params);
  if (decision.status === "denied") {
    throw new Error(`whatsapp group outbound denied: ${decision.reasonCode}`);
  }
}

export function resetWhatsAppOutboundAuthorizationForTests(): void {
  registeredWhatsAppAuthorizations.clear();
}
