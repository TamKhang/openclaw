/**
 * Host-derived Bruno Brain routing capability bridge.
 *
 * The model-facing MCP tool schema never carries `capability_id`. OpenClaw
 * derives this fact from trusted conversation/turn context, attaches it to the
 * MCP request `_meta`, and Bruno Brain applies it before policy enforcement.
 */
import { normalizeChatType } from "../channels/chat-type.js";
import type { PluginHookOutboundGroupReplyAuthorization } from "../plugins/hook-message.types.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";

/** MCP request `_meta` key shared with Bruno Brain. */
export const BRUNO_ROUTING_CAPABILITY_META_KEY = "io.openclaw.bruno/routing_capability";

/** Bruno Brain's process-event tool name; the only MCP tool this bridge targets. */
export const BRUNO_BRAIN_PROCESS_EVENT_TOOL_NAME = "bruno_brain_process_event";

/** Host-emitted routing capabilities. Premium and observation stay unbound. */
export const TRUSTED_BRUNO_ROUTING_CAPABILITIES = [
  "whatsapp.dm.standard",
  "whatsapp.group.reply_once",
] as const;

export type TrustedBrunoRoutingCapability = (typeof TRUSTED_BRUNO_ROUTING_CAPABILITIES)[number];

export function isTrustedBrunoRoutingCapability(
  value: string | undefined,
): value is TrustedBrunoRoutingCapability {
  return (
    value !== undefined && (TRUSTED_BRUNO_ROUTING_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function resolveTrustedBrunoRoutingCapability(params: {
  messageProvider?: string | null;
  messageChannel?: string | null;
  chatType?: string | null;
  outboundGroupReplyAuthorization?: PluginHookOutboundGroupReplyAuthorization | null;
}): TrustedBrunoRoutingCapability | undefined {
  const rawChannel = params.messageProvider ?? params.messageChannel;
  const channel = normalizeMessageChannel(rawChannel ?? undefined);
  if (channel !== "whatsapp") {
    return undefined;
  }

  const chatType = normalizeChatType(params.chatType ?? undefined);
  if (
    chatType === "group" &&
    params.outboundGroupReplyAuthorization?.capability === "whatsapp.group.reply_once"
  ) {
    return "whatsapp.group.reply_once";
  }
  if (chatType === "direct") {
    return "whatsapp.dm.standard";
  }
  return undefined;
}
