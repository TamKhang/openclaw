import {
  isAuthorizedTextSlashCommandTurn,
  isNativeCommandTurn,
} from "../../auto-reply/command-turn-context.js";
import { copyReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import {
  markReplyDispatchBeforeDeliverDeadlineOwned,
  type ReplyDispatchBeforeDeliver,
} from "../../auto-reply/reply/reply-dispatcher.js";
// Applies outbound hooks and shapes stable delivery outcomes/errors.
import { runReplyPayloadSendingHook } from "../../auto-reply/reply/reply-payload-sending-hook.js";
import { consumeReplyUsageState } from "../../auto-reply/reply/reply-usage-state.js";
import type { FinalizedMsgContext, MsgContext } from "../../auto-reply/templating.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  deriveInboundMessageHookContext,
  resolveInboundReplyHookTarget,
  toPluginMessageContext,
} from "../../hooks/message-hook-mappers.js";
import { hasOutboundReplyContent } from "../../plugin-sdk/reply-payload.js";
import type { PluginHookOutboundGroupReplyAuthorization } from "../../plugins/hook-message.types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { formatErrorMessage } from "../errors.js";
import { normalizeEmptyPayloadForDelivery } from "./deliver-payload.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryFailureStage,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
  type OutboundPayloadDeliverySuppressionReason,
} from "./deliver-types.js";
import type { QueuedReplyPayloadSendingHook } from "./delivery-queue-storage.js";
import {
  summarizeOutboundPayloadForTransport,
  type NormalizedOutboundPayload,
} from "./payloads.js";
import { isWhatsAppGroupDestination } from "./whatsapp-outbound-authorization.js";

export type ReplyPayloadSuppressedObserver = (
  payload: ReplyPayload,
  info: Parameters<ReplyDispatchBeforeDeliver>[1],
  reason: "cancelled_by_reply_payload_sending_hook" | "empty_after_reply_payload_sending_hook",
) => void | Promise<void>;

export function buildInboundReplyPayloadSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
  runState: { runId?: string },
  onSuppressed?: ReplyPayloadSuppressedObserver,
): ReplyDispatchBeforeDeliver {
  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  return markReplyDispatchBeforeDeliverDeadlineOwned(async (payload, info) => {
    const runId = runState.runId;
    const hookedPayload = await runReplyPayloadSendingHook({
      payload,
      kind: info.kind,
      channel: finalized.Surface ?? finalized.Provider,
      sessionKey: finalized.SessionKey,
      runId,
      usageState: consumeReplyUsageState(runId),
      context: { ...toPluginMessageContext(hookCtx), runId },
    });
    if (!hookedPayload) {
      await onSuppressed?.(payload, info, "cancelled_by_reply_payload_sending_hook");
      return null;
    }
    if (!hasOutboundReplyContent(hookedPayload)) {
      await onSuppressed?.(hookedPayload, info, "empty_after_reply_payload_sending_hook");
      return null;
    }
    return hookedPayload;
  });
}

/** Legacy dispatcher-owned `message_sending` stage retained for low-level SDK compatibility. */
const PROVENANCE_ENFORCEMENT_FAILED = "provenance_enforcement_failed";
const PROVENANCE_ENFORCEMENT_UNAVAILABLE = "provenance_enforcement_unavailable";

/**
 * Trusted provenance-exempt admission: only native command turns and authorized
 * text slash-command turns may skip mandatory provenance. Normal messages —
 * including text that merely looks command-like — are never exempt.
 */
export function resolveProvenanceExemptForDelivery(
  commandTurn: FinalizedMsgContext["CommandTurn"],
): boolean | undefined {
  return isNativeCommandTurn(commandTurn) || isAuthorizedTextSlashCommandTurn(commandTurn)
    ? true
    : undefined;
}

/**
 * Mandatory provenance enforcement is derived from trusted delivery context —
 * channel id plus the literal delivery destination — never from the serialized
 * session-key shape. This keeps owner-facing WhatsApp DMs fail-closed across
 * every supported session.dmScope, including the default `main` scope whose
 * session key is `agent:<agentId>:main`.
 */
function resolveProvenanceEnforcementFailClosed(params: {
  channel?: string;
  to?: string;
  provenanceExempt?: boolean;
}): boolean {
  if (params.provenanceExempt === true) {
    return false;
  }
  if (params.channel !== "whatsapp") {
    return false;
  }
  const to = params.to?.trim();
  return Boolean(to) && !isWhatsAppGroupDestination(to);
}

/**
 * A mandatory provenance decision must affirmatively deny (`cancel: true`) or
 * rewrite the outbound content as a string. A void/malformed result from the
 * enforcement hook is treated as a denial instead of silently allowing delivery.
 */
type MessageSendingResultLike = { cancel?: unknown; content?: unknown };

function isMessageSendingResultLike(value: unknown): value is MessageSendingResultLike {
  return Boolean(value) && typeof value === "object";
}

function isMandatoryMessageSendingResult(result: unknown): boolean {
  if (!isMessageSendingResultLike(result)) {
    return false;
  }
  return result.cancel === true || typeof result.content === "string";
}

export function buildLegacyInboundMessageSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
): ReplyDispatchBeforeDeliver | undefined {
  const hookRunner = getGlobalHookRunner();
  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  const replyTarget = resolveInboundReplyHookTarget(finalized, hookCtx);
  const provenanceExempt = resolveProvenanceExemptForDelivery(finalized.CommandTurn);
  const provenanceEnforcementFailClosed = resolveProvenanceEnforcementFailClosed({
    channel: hookCtx.channelId,
    to: replyTarget,
    provenanceExempt,
  });
  if (!hookRunner?.hasHooks("message_sending")) {
    if (!provenanceEnforcementFailClosed) {
      return undefined;
    }
    // Mandatory provenance has no enforcement hook available: deny instead of
    // letting the legacy dispatcher deliver an unfinalized owner-facing reply.
    return markReplyDispatchBeforeDeliverDeadlineOwned(async () => null);
  }
  return markReplyDispatchBeforeDeliverDeadlineOwned(
    async (payload: ReplyPayload): Promise<ReplyPayload | null> => {
      if (!payload.text) {
        return payload;
      }
      const messageContext = toPluginMessageContext(hookCtx);
      messageContext.provenanceExempt = provenanceExempt;
      let result;
      try {
        result = await hookRunner.runMessageSending(
          { content: payload.text, to: replyTarget },
          messageContext,
          { failClosedOnError: provenanceEnforcementFailClosed },
        );
      } catch (error) {
        if (!provenanceEnforcementFailClosed) {
          throw error;
        }
        return null;
      }
      if (result?.cancel) {
        return null;
      }
      if (provenanceEnforcementFailClosed && !isMandatoryMessageSendingResult(result)) {
        return null;
      }
      return result?.content == null
        ? payload
        : copyReplyPayloadMetadata(payload, { ...payload, text: result.content });
    },
  );
}

/** Run media-aware message policy before a core owner can capture projected output. */
export function buildProjectedInboundMessageSendingBeforeDeliver(
  ctx: MsgContext | FinalizedMsgContext,
): ReplyDispatchBeforeDeliver {
  const finalized = finalizeInboundContext(ctx);
  const hookCtx = deriveInboundMessageHookContext(finalized);
  const replyTarget = resolveInboundReplyHookTarget(finalized, hookCtx);
  return markReplyDispatchBeforeDeliverDeadlineOwned(async (payload) => {
    const hookRunner = getGlobalHookRunner();
    const hookResult = await applyMessageSendingHook({
      hookRunner,
      enabled: hookRunner?.hasHooks("message_sending") ?? false,
      payload,
      payloadSummary: summarizeOutboundPayloadForTransport(payload),
      to: replyTarget,
      channel: hookCtx.channelId,
      accountId: hookCtx.accountId,
      replyToId: payload.replyToId ?? finalized.ReplyToIdFull ?? finalized.ReplyToId,
      threadId: finalized.MessageThreadId,
      sessionKey: finalized.SessionKey,
      provenanceExempt: resolveProvenanceExemptForDelivery(finalized.CommandTurn),
    });
    if (hookResult.cancelled) {
      return null;
    }
    return normalizeEmptyPayloadForDelivery(hookResult.payload);
  });
}

export async function applyMessageSendingHook(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  enabled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
  to: string;
  channel: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  sessionKey?: string;
  outboundGroupReplyAuthorization?: PluginHookOutboundGroupReplyAuthorization;
  provenanceExempt?: boolean;
}): Promise<{
  cancelled: boolean;
  cancelReason?: string;
  hookMetadata?: Record<string, unknown>;
  contentRewritten: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
}> {
  const provenanceEnforcementFailClosed = resolveProvenanceEnforcementFailClosed({
    channel: params.channel,
    to: params.to,
    provenanceExempt: params.provenanceExempt,
  });
  const messageSendingAvailable = params.hookRunner?.hasHooks("message_sending") ?? false;
  if (provenanceEnforcementFailClosed && !messageSendingAvailable) {
    return {
      cancelled: true,
      cancelReason: PROVENANCE_ENFORCEMENT_UNAVAILABLE,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
  if (!params.enabled) {
    return {
      cancelled: false,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
  try {
    const sendingResult = await params.hookRunner!.runMessageSending(
      {
        to: params.to,
        content: params.payloadSummary.hookContent ?? params.payloadSummary.text,
        replyToId: params.replyToId ?? undefined,
        threadId: params.threadId ?? undefined,
        metadata: {
          channel: params.channel,
          accountId: params.accountId,
          mediaUrls: params.payloadSummary.mediaUrls,
        },
      },
      {
        channelId: params.channel,
        accountId: params.accountId ?? undefined,
        conversationId: params.to,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        ...(params.outboundGroupReplyAuthorization
          ? { outboundGroupReplyAuthorization: params.outboundGroupReplyAuthorization }
          : {}),
        ...(params.provenanceExempt === true ? { provenanceExempt: true } : {}),
      },
      { failClosedOnError: provenanceEnforcementFailClosed },
    );
    if (sendingResult?.cancel) {
      return {
        cancelled: true,
        ...(sendingResult.cancelReason ? { cancelReason: sendingResult.cancelReason } : {}),
        ...(sendingResult.metadata ? { hookMetadata: sendingResult.metadata } : {}),
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (provenanceEnforcementFailClosed && !isMandatoryMessageSendingResult(sendingResult)) {
      return {
        cancelled: true,
        cancelReason: PROVENANCE_ENFORCEMENT_FAILED,
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (sendingResult?.content == null) {
      return {
        cancelled: false,
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (params.payloadSummary.hookContent && !params.payloadSummary.text) {
      const spokenText = sendingResult.content;
      return {
        cancelled: false,
        contentRewritten: true,
        payload: {
          ...params.payload,
          spokenText,
        },
        payloadSummary: {
          ...params.payloadSummary,
          hookContent: spokenText,
        },
      };
    }
    const payload = {
      ...params.payload,
      text: sendingResult.content,
    };
    return {
      cancelled: false,
      contentRewritten: true,
      payload,
      payloadSummary: {
        ...params.payloadSummary,
        text: sendingResult.content,
      },
    };
  } catch {
    if (provenanceEnforcementFailClosed) {
      // Mandatory provenance enforcement failed or timed out: deny delivery
      // rather than letting a degraded runtime convert a missing DENY into ALLOW.
      return {
        cancelled: true,
        cancelReason: PROVENANCE_ENFORCEMENT_FAILED,
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    // Don't block delivery on hook failure for non-mandatory paths.
    return {
      cancelled: false,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
}

export async function applyReplyPayloadSendingHook(params: {
  hook: QueuedReplyPayloadSendingHook | undefined;
  payload: ReplyPayload;
}): Promise<{
  cancelled: boolean;
  payload: ReplyPayload;
  changed: boolean;
}> {
  if (!params.hook) {
    return { cancelled: false, payload: params.payload, changed: false };
  }
  const nextPayload = await runReplyPayloadSendingHook({
    payload: params.payload,
    kind: params.hook.kind,
    ...(params.hook.channel ? { channel: params.hook.channel } : {}),
    ...(params.hook.sessionKey ? { sessionKey: params.hook.sessionKey } : {}),
    ...(params.hook.runId ? { runId: params.hook.runId } : {}),
    context: params.hook.context,
  });
  if (!nextPayload) {
    return { cancelled: true, payload: params.payload, changed: false };
  }
  return {
    cancelled: false,
    payload: nextPayload,
    changed: nextPayload !== params.payload,
  };
}

export function toOutboundDeliveryError(params: {
  error: unknown;
  results: readonly OutboundDeliveryResult[];
  payloadOutcomes: readonly OutboundPayloadDeliveryOutcome[];
  stage: OutboundDeliveryFailureStage;
}): OutboundDeliveryError {
  if (params.error instanceof OutboundDeliveryError) {
    return params.error;
  }
  return new OutboundDeliveryError(formatErrorMessage(params.error), {
    cause: params.error,
    results: params.results,
    payloadOutcomes: params.payloadOutcomes,
    stage: params.stage,
  });
}

export function suppressedPayloadOutcome(params: {
  index: number;
  reason: OutboundPayloadDeliverySuppressionReason;
  hookEffect?: {
    cancelReason?: string;
    metadata?: Record<string, unknown>;
  };
}): OutboundPayloadDeliveryOutcome {
  return {
    index: params.index,
    status: "suppressed",
    reason: params.reason,
    ...(params.hookEffect ? { hookEffect: params.hookEffect } : {}),
  };
}

/** Adds directive-derived media to the queue copy before spool custody. */
