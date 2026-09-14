// Integration regression through the real outbound delivery choke point.
//
// These tests drive `deliverOutboundPayloadsCore` with a fake WhatsApp
// transport adapter and prove that one authorization permit authorizes at most
// one actual transport transmission.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { createUnmodifiedPreparedOutboundBatch } from "./prepared-batch.js";
import {
  registerWhatsAppOutboundAuthorization,
  resetWhatsAppOutboundAuthorizationForTests,
} from "./whatsapp-outbound-authorization.js";

const NOW = 1_800_000_000_000;
const GROUP = "84905113232-1552963395@g.us";
const ORIGIN = "owner-dm-event-1";

function basePermit() {
  return {
    authorizationClass: "owner_explicit_send" as const,
    policyVersion: 1 as const,
    actionType: "whatsapp.group.send" as const,
    token: "5d3e5f20-6b3c-4a0e-9f6a-2c9d7e2c4a1f",
    ownerE164: "+84938030977",
    groupId: GROUP,
    chatId: GROUP,
    sourceEventId: ORIGIN,
    createdAt: NOW,
    expiresAt: NOW + 300_000,
    maxSends: 1 as const,
  };
}

function delegatedPermit() {
  return {
    ...basePermit(),
    authorizationClass: "delegated_group_reply" as const,
    capability: "whatsapp.group.reply_once" as const,
    ownerTriggerMessageId: "trigger",
    quotedMessageId: "quoted",
    targetParticipantId: "target",
  };
}

function createResult(messageId = "wa-1") {
  return {
    channel: "whatsapp" as const,
    messageId,
    receipt: createMessageReceiptFromOutboundResults({
      results: messageId ? [{ channel: "whatsapp", messageId }] : [],
    }),
  };
}

function installOutbound(outbound: ChannelOutboundAdapter) {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "whatsapp",
        source: "test",
        plugin: createOutboundTestPlugin({ id: "whatsapp", outbound }),
      },
    ]),
  );
}

async function deliver(params: {
  to?: string;
  authorization?: unknown;
  payloads?: Array<{ text?: string; mediaUrls?: string[] }>;
  formatting?: { textLimit?: number };
}) {
  const payloads = params.payloads ?? [{ text: "Anyone playing today?" }];
  return await deliverOutboundPayloadsCore({
    cfg: {},
    channel: "whatsapp",
    to: params.to ?? GROUP,
    payloads,
    preparedBatch: createUnmodifiedPreparedOutboundBatch(payloads),
    outboundGroupReplyAuthorization: params.authorization as never,
    outboundAuthorizationOriginEventId: ORIGIN,
    ...(params.formatting ? { formatting: params.formatting } : {}),
  });
}

afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetWhatsAppOutboundAuthorizationForTests();
});

describe("whatsapp outbound transport integration (real delivery choke point)", () => {
  it("missing permit: zero adapter sends and delivery fails closed", async () => {
    const sendText = vi.fn(async () => createResult());
    installOutbound({ deliveryMode: "direct", sendText });
    await expect(deliver({})).rejects.toThrow("missing_permit");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("forged structurally valid permit never reaches the adapter", async () => {
    const sendText = vi.fn(async () => createResult());
    installOutbound({ deliveryMode: "direct", sendText });
    await expect(deliver({ authorization: basePermit() })).rejects.toThrow("unknown_authorization");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("registered owner_explicit_send permit yields exactly one adapter send", async () => {
    const permit = basePermit();
    registerWhatsAppOutboundAuthorization(permit);
    const sendText = vi.fn(async () => createResult());
    installOutbound({ deliveryMode: "direct", sendText });

    await deliver({ authorization: permit });
    expect(sendText).toHaveBeenCalledTimes(1);

    await expect(deliver({ authorization: permit })).rejects.toThrow("consumed_permit");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("one batch with two payloads cannot transmit both on one permit", async () => {
    const permit = basePermit();
    registerWhatsAppOutboundAuthorization(permit);
    const sendText = vi.fn(async () => createResult());
    installOutbound({ deliveryMode: "direct", sendText });

    await expect(
      deliver({
        authorization: permit,
        payloads: [{ text: "First" }, { text: "Second" }],
      }),
    ).rejects.toThrow("consumed_permit");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("one payload split into multiple chunks transmits at most one chunk", async () => {
    const permit = basePermit();
    registerWhatsAppOutboundAuthorization(permit);
    const sendText = vi.fn(async () => createResult());
    installOutbound({
      deliveryMode: "direct",
      sendText,
      chunker: (text, limit) => {
        const parts: string[] = [];
        for (let i = 0; i < text.length; i += limit) {
          parts.push(text.slice(i, i + limit));
        }
        return parts;
      },
    });

    await expect(
      deliver({
        authorization: permit,
        payloads: [{ text: "0123456789ABCDEFGHIJ" }],
        formatting: { textLimit: 4 },
      }),
    ).rejects.toThrow("consumed_permit");
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("text then media with the same permit denies the second transmission", async () => {
    const permit = basePermit();
    registerWhatsAppOutboundAuthorization(permit);
    const sendText = vi.fn(async () => createResult("text-1"));
    const sendMedia = vi.fn(async () => createResult("media-1"));
    installOutbound({ deliveryMode: "direct", sendText, sendMedia });

    await deliver({ authorization: permit, payloads: [{ text: "Hello" }] });
    expect(sendText).toHaveBeenCalledTimes(1);

    await expect(
      deliver({
        authorization: permit,
        payloads: [{ text: "", mediaUrls: ["https://example.com/a.png"] }],
      }),
    ).rejects.toThrow("consumed_permit");
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it("concurrent send attempts with one permit yield exactly one transport call", async () => {
    const permit = basePermit();
    registerWhatsAppOutboundAuthorization(permit);
    const sendText = vi.fn(async () => createResult());
    installOutbound({ deliveryMode: "direct", sendText });

    const results = await Promise.allSettled([
      deliver({ authorization: permit }),
      deliver({ authorization: permit }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(sendText).toHaveBeenCalledTimes(1);
  });

  it("diagnostic transport-boundary logging does not alter the one-shot gate", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const permit = basePermit();
    registerWhatsAppOutboundAuthorization(permit);
    const sendText = vi.fn(async () => createResult());
    installOutbound({ deliveryMode: "direct", sendText });

    await deliver({ authorization: permit });
    expect(sendText).toHaveBeenCalledTimes(1);

    const logged = logSpy.mock.calls.flat().map(String).join("\n");
    expect(logged).toContain("[come-in-policy-diag] whatsappTransportGateReached=true");
    expect(logged).toContain("[come-in-policy-diag] whatsappTransportGatePassed=true");
  });

  it("delegated_group_reply obeys the same actual-transmission one-shot rule", async () => {
    const permit = delegatedPermit();
    registerWhatsAppOutboundAuthorization(permit);
    const sendText = vi.fn(async () => createResult());
    installOutbound({ deliveryMode: "direct", sendText });

    await deliver({ authorization: permit });
    expect(sendText).toHaveBeenCalledTimes(1);

    await expect(deliver({ authorization: permit })).rejects.toThrow("consumed_permit");
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
