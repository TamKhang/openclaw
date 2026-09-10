import { describe, expect, it } from "vitest";
import type { PluginHookOutboundGroupReplyAuthorization } from "../plugins/hook-message.types.js";
import {
  isTrustedBrunoRoutingCapability,
  resolveTrustedBrunoRoutingCapability,
} from "./bruno-routing-capability.js";

function groupReplyAuthorization(): PluginHookOutboundGroupReplyAuthorization {
  return {
    capability: "whatsapp.group.reply_once",
    token: "token-1",
    groupId: "group-1",
    chatId: "group-1",
    ownerTriggerMessageId: "owner-trigger-1",
    quotedMessageId: "quoted-1",
    targetParticipantId: "participant-1",
  };
}

/**
 * Type-safe fixture for rejection tests. The runtime intentionally injects an
 * invalid capability string, so only this single field is narrowed to the
 * declared literal union. No broad cast is used.
 */
function groupReplyAuthorizationWithCapability(
  capability: string,
): PluginHookOutboundGroupReplyAuthorization {
  return {
    ...groupReplyAuthorization(),
    capability: capability as PluginHookOutboundGroupReplyAuthorization["capability"],
  };
}

describe("resolveTrustedBrunoRoutingCapability", () => {
  it("derives whatsapp.dm.standard for WhatsApp direct-message context", () => {
    expect(
      resolveTrustedBrunoRoutingCapability({
        messageProvider: "whatsapp",
        chatType: "direct",
      }),
    ).toBe("whatsapp.dm.standard");
  });

  it("derives reply_once only from trusted group reply delegation", () => {
    expect(
      resolveTrustedBrunoRoutingCapability({
        messageProvider: "whatsapp",
        chatType: "group",
        outboundGroupReplyAuthorization: groupReplyAuthorization(),
      }),
    ).toBe("whatsapp.group.reply_once");
  });

  it("keeps passive WhatsApp group observation model-free without delegation", () => {
    expect(
      resolveTrustedBrunoRoutingCapability({
        messageProvider: "whatsapp",
        chatType: "group",
      }),
    ).toBeUndefined();
  });

  it("rejects a group delegation marker with the wrong capability", () => {
    expect(
      resolveTrustedBrunoRoutingCapability({
        messageProvider: "whatsapp",
        chatType: "group",
        outboundGroupReplyAuthorization: groupReplyAuthorizationWithCapability(
          "whatsapp.dm.premium_requested",
        ),
      }),
    ).toBeUndefined();
  });

  it("does not derive a capability for non-WhatsApp channels", () => {
    expect(
      resolveTrustedBrunoRoutingCapability({
        messageProvider: "telegram",
        chatType: "direct",
        outboundGroupReplyAuthorization: groupReplyAuthorization(),
      }),
    ).toBeUndefined();
  });

  it("keeps premium_requested outside the host-emitted capability set", () => {
    expect(isTrustedBrunoRoutingCapability("whatsapp.dm.premium_requested")).toBe(false);
    expect(isTrustedBrunoRoutingCapability("whatsapp.group.observe")).toBe(false);
  });
});
