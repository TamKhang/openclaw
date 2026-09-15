// WhatsApp plugin implements the owner-authorized Bruno High Brain trigger.
//
// "Bruno, high brain:" is a one-query HIGH classification/tier override, not
// an explicit model override. DM form is `Bruno, high brain: <query>` (exact
// case/punctuation-sensitive prefix, exactly one space after the colon, and a
// non-empty inline query). Group form is the bare trigger with exactly one
// quoted message, whose body supplies the semantic query.
//
// Recognition is host-derived from authentic WhatsApp channel context: exact
// trigger parsing, verified owner identity, valid DM or quoted-group
// structure, and stable inbound event identity. The HIGH override is a
// separate registered fact from the delegated_group_reply send authorization.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getSelfIdentity, getSenderIdentity } from "../../identity.js";
import { requireWhatsAppInboundAdmission } from "../../inbound/admission.js";
import { resolveWhatsAppInboundEventIdentity } from "../../inbound/inbound-event-identity.js";
import type { AdmittedWebInboundMessage } from "../../inbound/types.js";
import { getOptionalWhatsAppHighBrainClassificationRegistrar } from "../../runtime.js";
import { normalizeE164 } from "../../text-runtime.js";
import type { MentionConfig } from "../mentions.js";
import { resolveOwnerList } from "../mentions.js";
import { authorizeExplicitOwnerGroupReply, GROUP_REPLY_ONCE_TTL_MS } from "./group-reply-once.js";

export const HIGH_BRAIN_TRIGGER_PREFIX = "Bruno, high brain:";
export const HIGH_BRAIN_OVERRIDE_TTL_MS = GROUP_REPLY_ONCE_TTL_MS;
export const HIGH_BRAIN_REQUESTED_TIER = "high" as const;

export type HighBrainRecognitionResult =
  | { status: "not_trigger" }
  | {
      status: "authorized";
      sourceEventId: string;
      /** Semantic query to classify: stripped DM query or quoted group body. */
      query: string;
      mode: "dm" | "group";
    }
  | { status: "denied"; reason: string };

function resolveOwnerE164s(
  msg: AdmittedWebInboundMessage,
  mentionConfig: MentionConfig,
  authDir?: string,
): string[] {
  return resolveOwnerList(mentionConfig, getSelfIdentity(msg, authDir).e164 ?? undefined);
}

function resolveOwnerSenderE164(
  msg: AdmittedWebInboundMessage,
  authDir?: string,
): string | undefined {
  const sender = normalizeE164(getSenderIdentity(msg, authDir).e164 ?? "");
  return sender || undefined;
}

/**
 * Parses the canonical DM form `Bruno, high brain: <query>`.
 *
 * The prefix is exact and case/punctuation-sensitive; exactly one space
 * follows the colon before a non-empty query. Anything else does not trigger
 * (wrong case, punctuation, spacing, bare trigger, empty query).
 */
export function parseHighBrainDmBody(
  body: string,
):
  | { status: "trigger"; query: string }
  | { status: "not_trigger" }
  | { status: "malformed"; reason: string } {
  if (!body.startsWith(HIGH_BRAIN_TRIGGER_PREFIX)) {
    return { status: "not_trigger" };
  }
  const afterColon = body.slice(HIGH_BRAIN_TRIGGER_PREFIX.length);
  if (!afterColon.startsWith(" ") || afterColon.startsWith("  ")) {
    return { status: "malformed", reason: "wrong_spacing" };
  }
  const query = afterColon.slice(1);
  if (query.trim().length === 0) {
    return { status: "malformed", reason: "empty_query" };
  }
  return { status: "trigger", query };
}

function registerHighBrainOverride(params: {
  sourceEventId: string;
  mode: "dm" | "group";
  now: number;
}): { ok: true } | { ok: false; reason: string } {
  const registrar = getOptionalWhatsAppHighBrainClassificationRegistrar();
  if (!registrar) {
    return { ok: false, reason: "high_brain_registration_unavailable" };
  }
  let result: unknown;
  try {
    result = registrar({
      policyVersion: 1,
      sourceEventId: params.sourceEventId,
      mode: params.mode,
      requestedTier: HIGH_BRAIN_REQUESTED_TIER,
      createdAt: params.now,
      expiresAt: params.now + HIGH_BRAIN_OVERRIDE_TTL_MS,
    });
  } catch {
    return { ok: false, reason: "high_brain_registration_threw" };
  }
  // A canonical registrar is void-returning. Any non-undefined return means the
  // injected registrar refused registration or produced a malformed result;
  // never treat that as a silent registration success.
  if (result !== undefined) {
    return { ok: false, reason: "high_brain_registration_refused" };
  }
  return { ok: true };
}

/**
 * Recognizes a valid owner-authorized DM High Brain trigger. The stripped
 * query is returned for downstream processing; the caller must replace the
 * agent-facing body with it. Malformed, non-owner, or non-direct input never
 * activates the override.
 */
export function authorizeHighBrainDm(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  baseMentionConfig: MentionConfig;
  authDir?: string;
}): HighBrainRecognitionResult {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  if (admission.conversation.kind !== "direct") {
    return { status: "not_trigger" };
  }
  const body = params.msg.payload.commandBody ?? params.msg.payload.body;
  const parsed = parseHighBrainDmBody(body);
  if (parsed.status !== "trigger") {
    // A malformed trigger is ordinary text, not a privileged request. It must
    // route through ordinary semantic processing, never be conflated with an
    // exact-trigger authorization denial.
    return { status: "not_trigger" };
  }

  const ownerSenderId = resolveOwnerSenderE164(params.msg, params.authDir);
  if (!ownerSenderId) {
    return { status: "denied", reason: "missing_owner_identity" };
  }
  const owners = resolveOwnerE164s(params.msg, params.baseMentionConfig, params.authDir);
  if (!owners.includes(ownerSenderId)) {
    return { status: "denied", reason: "not_owner" };
  }

  const identity = resolveWhatsAppInboundEventIdentity(params.msg);
  if (identity.status !== "resolved") {
    return { status: "denied", reason: `unstable_source_event_identity:${identity.reason}` };
  }

  const registered = registerHighBrainOverride({
    sourceEventId: identity.sourceEventId,
    mode: "dm",
    now: Date.now(),
  });
  if (!registered.ok) {
    return { status: "denied", reason: registered.reason };
  }

  return {
    status: "authorized",
    sourceEventId: identity.sourceEventId,
    query: parsed.query,
    mode: "dm",
  };
}

/**
 * Recognizes a valid owner-authorized group High Brain trigger: the bare
 * `Bruno, high brain:` body plus exactly one quoted message. The quoted body
 * supplies the semantic query. Send authority reuses Task 1's hardened
 * delegated_group_reply minting; the HIGH classification override is a
 * separate registered fact.
 */
export function authorizeHighBrainGroup(params: {
  cfg: OpenClawConfig;
  msg: AdmittedWebInboundMessage;
  baseMentionConfig: MentionConfig;
  authDir?: string;
  groupHistoryKey: string;
  groupMemberNames: Map<string, Map<string, string>>;
  authoritativeDisplayName?: string;
  otherParticipantNames?: string[];
}): HighBrainRecognitionResult {
  const admission = requireWhatsAppInboundAdmission(params.msg);
  if (admission.conversation.kind !== "group") {
    return { status: "not_trigger" };
  }
  const body = params.msg.payload.commandBody ?? params.msg.payload.body;
  if (body !== HIGH_BRAIN_TRIGGER_PREFIX) {
    return { status: "not_trigger" };
  }

  // Reuse Task 1's hardened delegated group reply minting (exact owner, quote,
  // event identity, TTL, one-shot, registrar). The trigger body differs but
  // the authorization class and transport semantics are identical.
  const delegated = authorizeExplicitOwnerGroupReply({
    cfg: params.cfg,
    msg: params.msg,
    baseMentionConfig: params.baseMentionConfig,
    authDir: params.authDir,
    groupHistoryKey: params.groupHistoryKey,
    groupMemberNames: params.groupMemberNames,
    authoritativeDisplayName: params.authoritativeDisplayName,
    otherParticipantNames: params.otherParticipantNames,
    trigger: HIGH_BRAIN_TRIGGER_PREFIX,
  });
  if (delegated.status !== "authorized") {
    return {
      status: "denied",
      reason: delegated.status === "denied" ? delegated.reason : "delegated_reply_unavailable",
    };
  }

  const registered = registerHighBrainOverride({
    sourceEventId: delegated.authorization.sourceEventId,
    mode: "group",
    now: Date.now(),
  });
  if (!registered.ok) {
    return { status: "denied", reason: registered.reason };
  }

  return {
    status: "authorized",
    sourceEventId: delegated.authorization.sourceEventId,
    query: delegated.authorization.quotedBody,
    mode: "group",
  };
}
