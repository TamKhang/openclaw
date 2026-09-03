import {
  createInternalHookEvent,
  deriveInboundMessageHookContext,
  fireAndForgetBoundedHook,
  toInternalMessageReceivedContext,
  toPluginMessageContext,
  toPluginMessageReceivedEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
// WhatsApp observation helpers keep opted-in `message_received` emission on a
// lightweight boundary shared by pre-gate, blocked, and admitted paths.
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { LoadConfigFn } from "../auto-reply/monitor/runtime-api.js";

const WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS = {
  maxConcurrency: 8,
  maxQueue: 128,
  timeoutMs: 2_000,
};

type WhatsAppMessageReceivedHookConfig = {
  pluginHooks?: {
    messageReceived?: boolean;
  };
  accounts?: Record<string, unknown>;
};

function readWhatsAppMessageReceivedHookOptIn(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const pluginHooks = (value as WhatsAppMessageReceivedHookConfig).pluginHooks;
  if (pluginHooks?.messageReceived === undefined) {
    return undefined;
  }
  return pluginHooks.messageReceived;
}

export function shouldEmitWhatsAppMessageReceivedHooks(params: {
  cfg: ReturnType<LoadConfigFn>;
  accountId?: string;
}): boolean {
  const channelConfig = params.cfg.channels?.whatsapp as
    | WhatsAppMessageReceivedHookConfig
    | undefined;
  const accountConfig =
    params.accountId && channelConfig?.accounts
      ? channelConfig.accounts[params.accountId]
      : undefined;

  return (
    readWhatsAppMessageReceivedHookOptIn(accountConfig) ??
    readWhatsAppMessageReceivedHookOptIn(channelConfig) ??
    false
  );
}

export function emitWhatsAppMessageReceivedHooks(params: {
  ctx: FinalizedMsgContext;
  sessionKey: string;
}): void {
  const canonical = deriveInboundMessageHookContext(params.ctx);
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("message_received")) {
    fireAndForgetBoundedHook(
      () =>
        hookRunner.runMessageReceived(
          toPluginMessageReceivedEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      "whatsapp: message_received plugin hook failed",
      undefined,
      WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS,
    );
  }
  fireAndForgetBoundedHook(
    () =>
      triggerInternalHook(
        createInternalHookEvent(
          "message",
          "received",
          params.sessionKey,
          toInternalMessageReceivedContext(canonical),
        ),
      ),
    "whatsapp: message_received internal hook failed",
    undefined,
    WHATSAPP_MESSAGE_RECEIVED_HOOK_LIMITS,
  );
}

/** Emit the observation-only hook for a group inbound message rejected by access control. */
export function emitBlockedWhatsAppGroupObservation(params: {
  cfg: ReturnType<LoadConfigFn>;
  accountId: string;
  selfE164: string | null;
  body: string;
  id?: string;
  remoteJid: string;
  participantJid?: string;
  senderE164: string | null;
  groupSubject?: string;
  messageTimestampMs?: number;
  pushName?: string;
}): void {
  if (
    !shouldEmitWhatsAppMessageReceivedHooks({
      cfg: params.cfg,
      accountId: params.accountId,
    })
  ) {
    return;
  }

  const sessionKey = `agent:observation:whatsapp:group:${params.remoteJid}`;
  const ctx = {
    From: params.remoteJid,
    To: params.selfE164 ?? "me",
    Body: params.body,
    RawBody: params.body,
    BodyForAgent: params.body,
    BodyForCommands: params.body,
    OriginatingChannel: "whatsapp",
    Surface: "whatsapp",
    Provider: "whatsapp",
    OriginatingTo: params.remoteJid,
    GroupSubject: params.groupSubject,
    GroupChannel: params.remoteJid,
    Timestamp: params.messageTimestampMs,
    MessageSid: params.id,
    MessageSidFull: params.id,
    AccountId: params.accountId,
    SessionKey: sessionKey,
    SenderId: params.participantJid ?? params.senderE164 ?? undefined,
    SenderName: params.pushName,
    SenderE164: params.senderE164 ?? undefined,
  } as FinalizedMsgContext;

  emitWhatsAppMessageReceivedHooks({
    ctx,
    sessionKey,
  });
}
