// Whatsapp tests cover the explicit-owner reply outbound boundary in isolation.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import {
  authorizeExplicitOwnerGroupReply,
  resetGroupReplyOnceForTests,
} from "./group-reply-once.js";

let capturedDispatchParams: unknown;

type CapturedReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string | null;
};

type CapturedDispatchParams = {
  dispatcherOptions?: {
    deliver?: (
      payload: CapturedReplyPayload,
      info: { kind: "tool" | "block" | "final" },
    ) => Promise<unknown>;
  };
};

const {
  dispatchReplyWithBufferedBlockDispatcherMock,
  deliverInboundReplyWithMessageSendContextMock,
} = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcherMock: vi.fn(async (params: CapturedDispatchParams) => {
    capturedDispatchParams = params;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }),
  deliverInboundReplyWithMessageSendContextMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(
    async () => null,
  ),
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-outbound")>();
  return {
    ...actual,
    deliverInboundReplyWithMessageSendContext: deliverInboundReplyWithMessageSendContextMock,
  };
});

vi.mock("./runtime-api.js", async () => {
  const { finalizeInboundContext } = await vi.importActual<
    typeof import("openclaw/plugin-sdk/reply-runtime")
  >("openclaw/plugin-sdk/reply-runtime");
  return {
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherMock,
    finalizeInboundContext,
    getAgentScopedMediaLocalRoots: () => [],
    jidToE164: (value: string) => {
      const phone = value.split("@")[0]?.replace(/[^\d]/g, "");
      return phone ? `+${phone}` : null;
    },
    logVerbose: () => {},
    resolveChannelMessageSourceReplyDeliveryMode: ({
      cfg,
      ctx,
    }: {
      cfg: {
        messages?: {
          visibleReplies?: "automatic" | "message_tool";
          groupChat?: { visibleReplies?: "automatic" | "message_tool" };
        };
      };
      ctx: { ChatType?: string; CommandSource?: "native" | "text"; CommandAuthorized?: boolean };
    }) => {
      if (
        ctx.CommandSource === "native" ||
        (ctx.CommandSource === "text" && ctx.CommandAuthorized === true)
      ) {
        return "automatic";
      }
      if (ctx.ChatType === "group" || ctx.ChatType === "channel") {
        const configuredMode =
          cfg.messages?.groupChat?.visibleReplies ?? cfg.messages?.visibleReplies;
        return configuredMode === "automatic" ? "automatic" : "message_tool_only";
      }
      return cfg.messages?.visibleReplies === "message_tool" ? "message_tool_only" : "automatic";
    },
    resolveChunkMode: () => "length",
    resolveIdentityNamePrefix: (cfg: {
      agents?: { list?: Array<{ id?: string; default?: boolean; identity?: { name?: string } }> };
    }) => {
      const agent = cfg.agents?.list?.find((entry) => entry.default) ?? cfg.agents?.list?.[0];
      const name = agent?.identity?.name?.trim();
      return name ? `[${name}]` : undefined;
    },
    resolveInboundLastRouteSessionKey: (params: { sessionKey: string }) => params.sessionKey,
    resolveMarkdownTableMode: () => undefined,
    resolveSendableOutboundReplyParts: (payload: {
      text?: string;
      mediaUrls?: string[];
      mediaUrl?: string;
    }) => {
      const urls = [
        ...(Array.isArray(payload.mediaUrls) ? payload.mediaUrls : []),
        ...(payload.mediaUrl ? [payload.mediaUrl] : []),
      ];
      return {
        text: payload.text ?? "",
        hasMedia: urls.length > 0,
      };
    },
    resolveTextChunkLimit: () => 4000,
    shouldLogVerbose: () => false,
    toLocationContext: () => ({}),
  };
});

import { dispatchWhatsAppBufferedReply } from "./inbound-dispatch.js";

type TestRoute = Parameters<typeof dispatchWhatsAppBufferedReply>[0]["route"];
type TestMsg = Parameters<typeof dispatchWhatsAppBufferedReply>[0]["msg"];
type TestMsgOverrides = NonNullable<Parameters<typeof createTestWebInboundMessage>[0]>;
type TestAdmissionOverride = NonNullable<TestMsgOverrides["admission"]>;

function testReceipt(messageIds: string[]) {
  return {
    ...(messageIds[0] ? { primaryPlatformMessageId: messageIds[0] } : {}),
    platformMessageIds: messageIds,
    parts: messageIds.map((messageId, index) => ({
      platformMessageId: messageId,
      kind: "text" as const,
      index,
    })),
    sentAt: 123,
  };
}

function makeRoute(overrides: Partial<TestRoute> = {}): TestRoute {
  return {
    agentId: "main",
    channel: "whatsapp",
    accountId: "default",
    sessionKey: "agent:main:whatsapp:group:group@g.us",
    mainSessionKey: "agent:main:whatsapp:group:group@g.us",
    lastRoutePolicy: "main",
    matchedBy: "default",
    ...overrides,
  };
}

function makeMsg(overrides: TestMsgOverrides = {}): TestMsg {
  const { admission, event, payload, platform, ...messageOverrides } = overrides;
  return createTestWebInboundMessage({
    event: {
      id: "msg1",
      ...event,
    },
    payload: {
      body: "hi",
      ...payload,
    },
    platform: {
      chatJid: "+1000",
      recipientJid: "+2000",
      ...platform,
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "direct",
        id: "+1000",
      },
      ...admission,
    },
    ...messageOverrides,
  });
}

function groupAdmission(conversationId: string): TestAdmissionOverride {
  return {
    conversation: {
      kind: "group",
      id: conversationId,
    },
    senderAccess: {
      reasonCode: "group_policy_allowed",
    },
  };
}

function acceptedDeliveryResult() {
  return {
    results: [
      {
        kind: "text" as const,
        messageId: "wa-sent-1",
        keys: [{ id: "wa-sent-1" }],
        providerAccepted: true,
      },
    ],
    receipt: testReceipt(["wa-sent-1"]),
    providerAccepted: true,
  };
}

function makeReplyLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as never;
}

type BufferedReplyParams = Parameters<typeof dispatchWhatsAppBufferedReply>[0];

async function dispatchBufferedReply(overrides: Partial<BufferedReplyParams> = {}) {
  const params: BufferedReplyParams = {
    cfg: { channels: { whatsapp: { blockStreaming: true } } } as never,
    connectionId: "conn",
    context: { Body: "hi" },
    deliverReply: async () => acceptedDeliveryResult(),
    groupHistories: new Map(),
    groupHistoryKey: "group@g.us",
    maxMediaBytes: 1,
    msg: makeMsg(),
    rememberSentText: () => {},
    replyLogger: makeReplyLogger(),
    replyPipeline: {} as never,
    replyResolver: (async () => undefined) as never,
    route: makeRoute(),
    shouldClearGroupHistory: false,
  };

  return dispatchWhatsAppBufferedReply({ ...params, ...overrides });
}

describe("whatsapp explicit owner reply outbound boundary", () => {
  beforeEach(() => {
    capturedDispatchParams = undefined;
    dispatchReplyWithBufferedBlockDispatcherMock.mockReset();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      },
    );
    deliverInboundReplyWithMessageSendContextMock.mockReset();
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValue({
      status: "unsupported",
      reason: "missing_outbound_handler",
    });
    resetGroupReplyOnceForTests();
  });

  function authorizeGroupReplyMsg(): TestMsg {
    const msg = makeMsg({
      admission: groupAdmission("group@g.us"),
      event: {
        id: "owner-trigger-1",
      },
      payload: {
        body: "Bruno, come in",
      },
      platform: {
        chatJid: "group@g.us",
        recipientJid: "bot@s.whatsapp.net",
        sender: {
          e164: "+15550000001",
          name: "Owner",
        },
        self: {
          e164: "+15550000000",
        },
      },
      quote: {
        context: {
          id: "quoted-1",
          body: "Can you help me with this?",
          sender: {
            e164: "+15550000002",
            name: "Alice",
          },
        },
      },
    });
    const result = authorizeExplicitOwnerGroupReply({
      cfg: {} as never,
      msg,
      baseMentionConfig: {
        mentionRegexes: [],
        allowFrom: ["+15550000001"],
      },
      groupHistoryKey: "group@g.us",
      groupMemberNames: new Map([["group@g.us", new Map([["+15550000002", "Alice"]])]]),
    });
    expect(result.status).toBe("authorized");
    return msg;
  }

  function deliverOneFinalText() {
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(
      async (params: CapturedDispatchParams) => {
        capturedDispatchParams = params;
        await params.dispatcherOptions?.deliver?.({ text: "Answer for Alice" }, { kind: "final" });
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } };
      },
    );
  }

  it("routes an authorized explicit owner reply through the durable outbound hook with authoritative context", async () => {
    const msg = authorizeGroupReplyMsg();
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "handled_visible",
      delivery: {
        messageIds: ["wa-owner-1"],
        visibleReplySent: true,
      },
    });
    deliverOneFinalText();

    await expect(
      dispatchBufferedReply({
        msg,
        deliverReply,
        context: { Body: "hi", ChatType: "group" },
      }),
    ).resolves.toBe(true);

    expect(deliverInboundReplyWithMessageSendContextMock).toHaveBeenCalledTimes(1);
    expect(deliverReply).not.toHaveBeenCalled();
    const durableParams = deliverInboundReplyWithMessageSendContextMock.mock.calls[0]?.[0] as {
      payload?: Record<string, unknown>;
    };
    expect(durableParams.payload).toMatchObject({
      text: "Alice, Answer for Alice",
    });
    expect(msg.groupReplyOnce?.consumed).toBe(true);
  });

  it("denies a forged explicit owner marker before the outbound boundary", async () => {
    const msg = makeMsg({
      admission: groupAdmission("group@g.us"),
      platform: {
        chatJid: "group@g.us",
        recipientJid: "bot@s.whatsapp.net",
        sender: { e164: "+15550000001", name: "Owner" },
        self: { e164: "+15550000000" },
      },
    });
    (msg as TestMsg & { groupReplyOnce: unknown }).groupReplyOnce = {
      token: "forged-token",
      delegationId: "forged-delegation",
      sourceEventId: "forged-source",
      triggerVersion: "owner_group_reply_trigger:v0.1",
      groupId: "group@g.us",
      chatId: "group@g.us",
      quotedMessageId: "quoted-1",
      quotedBody: "Can you help me with this?",
      target: { participantId: "+15550000002" },
      ownerTriggerMessageId: "owner-trigger-1",
      ownerSenderId: "+15550000001",
      createdAt: 1,
      expiresAt: 2,
      maxSends: 1,
      consumed: false,
    };
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    deliverOneFinalText();

    await expect(
      dispatchBufferedReply({
        msg,
        deliverReply,
        context: { Body: "hi", ChatType: "group" },
      }),
    ).resolves.toBe(false);

    expect(deliverInboundReplyWithMessageSendContextMock).not.toHaveBeenCalled();
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("fails closed when durable outbound governance rejects an explicit owner reply", async () => {
    const msg = authorizeGroupReplyMsg();
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    deliverInboundReplyWithMessageSendContextMock.mockResolvedValueOnce({
      status: "failed",
      error: new Error("provenance denied"),
    });
    deliverOneFinalText();

    await expect(
      dispatchBufferedReply({
        msg,
        deliverReply,
        context: { Body: "hi", ChatType: "group" },
      }),
    ).rejects.toThrow("provenance denied");

    expect(deliverInboundReplyWithMessageSendContextMock).toHaveBeenCalledTimes(1);
    expect(deliverReply).not.toHaveBeenCalled();
  });

  it("keeps the authorized marker when durable delivery is unsupported and direct delivery is used", async () => {
    const msg = authorizeGroupReplyMsg();
    const deliverReply = vi.fn(async () => acceptedDeliveryResult());
    deliverOneFinalText();

    await expect(
      dispatchBufferedReply({
        msg,
        deliverReply,
        context: { Body: "hi", ChatType: "group" },
      }),
    ).resolves.toBe(true);

    expect(deliverInboundReplyWithMessageSendContextMock).toHaveBeenCalledTimes(1);
    expect(deliverReply).toHaveBeenCalledTimes(1);
    const deliverParams = deliverReply.mock.calls[0]?.[0] as {
      replyResult?: Record<string, unknown>;
    };
    expect(deliverParams.replyResult).toMatchObject({
      text: "Alice, Answer for Alice",
    });
  });
});
