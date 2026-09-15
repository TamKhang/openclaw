// Whatsapp tests cover process message plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAcceptedWhatsAppSendResult } from "../../inbound/send-result.test-helper.js";
import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";

// Hoisted mocks used across tests so vi.mock factories can reference them.
const {
  resolvePolicyMock,
  buildContextMock,
  isControlCommandMessageMock,
  dispatchBufferedReplyMock,
  replyPlanParamsMock,
  runChannelInboundEventParamsMock,
  runMessageReceivedMock,
  shouldComputeCommandAuthorizedMock,
  trackBackgroundTaskMock,
} = vi.hoisted(() => ({
  resolvePolicyMock: vi.fn(),
  buildContextMock: vi.fn(),
  isControlCommandMessageMock: vi.fn(() => false),
  dispatchBufferedReplyMock: vi.fn(async (_params?: unknown) => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
  replyPlanParamsMock: vi.fn(),
  runChannelInboundEventParamsMock: vi.fn(),
  runMessageReceivedMock: vi.fn(async () => undefined),
  shouldComputeCommandAuthorizedMock: vi.fn(() => false),
  trackBackgroundTaskMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    runChannelInboundEvent: async (params: Parameters<typeof actual.runChannelInboundEvent>[0]) => {
      runChannelInboundEventParamsMock(params);
      return await actual.runChannelInboundEvent(params);
    },
  };
});

vi.mock("../../inbound-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../inbound-policy.js")>();
  return {
    ...actual,
    resolveWhatsAppCommandAuthorized: async () => true,
    resolveWhatsAppInboundPolicy: resolvePolicyMock,
  };
});

vi.mock("./inbound-dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-dispatch.js")>();
  return {
    ...actual,
    prepareWhatsAppInboundContext: async (
      params: Parameters<typeof actual.prepareWhatsAppInboundContext>[0],
    ) => {
      const prepared = await actual.prepareWhatsAppInboundContext(params);
      return {
        ...prepared,
        ctxPayload: buildContextMock(params),
      };
    },
    createWhatsAppReplyPlan: (...args: unknown[]) => {
      const params = args[0] as { replyResolver?: unknown };
      replyPlanParamsMock(params);
      void dispatchBufferedReplyMock(params);
      return {
        dispatcherOptions: {},
        delivery: { deliver: async () => {} },
        replyOptions: {},
        replyResolver: params.replyResolver,
        finalize: () => true,
      };
    },
    resolveWhatsAppDmRouteTarget: () => null,
    resolveWhatsAppResponsePrefix: () => undefined,
    updateWhatsAppMainLastRoute: () => {},
  };
});

vi.mock("openclaw/plugin-sdk/plugin-runtime", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "message_received",
    runMessageReceived: runMessageReceivedMock,
  }),
}));

vi.mock("../../identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../identity.js")>();
  return {
    ...actual,
    getPrimaryIdentityId: () => null,
    getSelfIdentity: () => ({ e164: "+15550001111" }),
    getSenderIdentity: () => ({ name: "Alice", e164: "+15550002222" }),
  };
});

vi.mock("../../reconnect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../reconnect.js")>();
  return { ...actual, newConnectionId: () => "test-conn-id" };
});

vi.mock("../../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../session.js")>();
  return { ...actual, formatError: (e: unknown) => String(e) };
});

vi.mock("../deliver-reply.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../deliver-reply.js")>();
  return { ...actual, deliverWebReply: async () => {} };
});

vi.mock("../loggers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../loggers.js")>();
  return {
    ...actual,
    whatsappInboundLog: { info: () => {}, debug: () => {} },
  };
});

vi.mock("./ack-reaction.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ack-reaction.js")>();
  return { ...actual, maybeSendAckReaction: async () => {} };
});

vi.mock("./inbound-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./inbound-context.js")>();
  return {
    ...actual,
    resolveVisibleWhatsAppGroupHistory: (params: { history: unknown[] }) => params.history,
    resolveVisibleWhatsAppReplyContext: () => null,
  };
});

vi.mock("./last-route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./last-route.js")>();
  return {
    ...actual,
    trackBackgroundTask: trackBackgroundTaskMock,
    updateLastRouteInBackground: () => {},
  };
});

vi.mock("./message-line.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./message-line.js")>();
  return { ...actual, buildInboundLine: () => "hi" };
});

vi.mock("./runtime-api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime-api.js")>();
  return {
    ...actual,
    buildHistoryContextFromEntries: () => "hi",
    createChannelMessageReplyPipeline: () => ({
      onModelSelected: () => {},
      responsePrefix: undefined,
    }),
    formatInboundEnvelope: () => "hi",
    logVerbose: () => {},
    normalizeE164: (v: string) => v,
    recordSessionMetaFromInbound: async () => {},
    resolveChannelContextVisibilityMode: () => "off",
    resolveInboundSessionEnvelopeContext: () => ({
      storePath: "/tmp",
      envelopeOptions: {},
      previousTimestamp: undefined,
    }),
    resolvePinnedMainDmOwnerFromAllowlist: () => null,
    isControlCommandMessage: isControlCommandMessageMock,
    shouldComputeCommandAuthorized: shouldComputeCommandAuthorizedMock,
    shouldLogVerbose: () => false,
  };
});

import { clearInternalHooks, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { attachWhatsAppIngressLifecycle } from "../../inbound/ingress-lifecycle.js";
import {
  resetWhatsAppHighBrainClassificationRegistrarForTests,
  setWhatsAppHighBrainClassificationRegistrar,
  type WhatsAppHighBrainClassificationRegistrar,
} from "../../runtime.js";
import { processMessage } from "./process-message.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAccount(groups: Record<string, { systemPrompt?: string }> = {}): {
  accountId: string;
  authDir: string;
  groups: Record<string, { systemPrompt?: string }>;
} {
  return { accountId: "default", authDir: "/tmp/wa-test-auth", groups };
}

function makePolicy(account: ReturnType<typeof makeAccount>) {
  return {
    account,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    configuredAllowFrom: [],
    dmAllowFrom: [],
    groupAllowFrom: [],
    isSelfChat: false,
    providerMissingFallbackApplied: false,
    isSamePhone: () => false,
    resolveConversationGroupPolicy: () => "allowlist",
    resolveConversationRequireMention: () => false,
  };
}

const GROUP_JID = "123@g.us";

function makeBaseMsg(overrides: { body?: string; commandBody?: string } = {}) {
  const body = overrides.body ?? "hi";
  return createTestWebInboundMessage({
    event: {
      id: "msg1",
      timestamp: 1710000000,
    },
    payload: {
      body,
      commandBody: overrides.commandBody,
    },
    platform: {
      chatJid: GROUP_JID,
      recipientJid: "+15550001111",
      senderJid: "15550002222@s.whatsapp.net",
      senderE164: "+15550002222",
      senderName: "Alice",
      sendComposing: async () => {},
      reply: async () => createAcceptedWhatsAppSendResult("text", "r1"),
      sendMedia: async () => createAcceptedWhatsAppSendResult("media", "m1"),
    },
    admission: {
      accountId: "default",
      conversation: {
        kind: "group",
        id: GROUP_JID,
      },
      sender: {
        id: "+15550002222",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
    group: {
      subject: "Test Group",
    },
  });
}

const baseRoute = {
  agentId: "main",
  channel: "whatsapp",
  accountId: "default",
  sessionKey: "agent:main:whatsapp:group:123@g.us",
  mainSessionKey: "agent:main:whatsapp:group:123@g.us",
  lastRoutePolicy: "main",
  matchedBy: "default",
};

function callProcessMessage(
  overrides: {
    cfg?: unknown;
    dispatchReplyFromConfig?: Parameters<typeof processMessage>[0]["dispatchReplyFromConfig"];
    groupHistories?: Map<string, unknown[]>;
    msg?: unknown;
    messageReceivedEmitted?: boolean;
    replyLogger?: { warn: (obj: unknown, msg: string) => void };
  } = {},
) {
  return processMessage({
    cfg: (overrides.cfg ?? {}) as never,
    msg: (overrides.msg ?? makeBaseMsg()) as never,
    route: baseRoute as never,
    groupHistoryKey: "whatsapp:default:group:123@g.us",
    groupHistories: (overrides.groupHistories ?? new Map()) as never,
    groupMemberNames: new Map(),
    connectionId: "conn-1",
    verbose: false,
    messageReceivedEmitted: overrides.messageReceivedEmitted,
    maxMediaBytes: 1024,
    dispatchReplyFromConfig: overrides.dispatchReplyFromConfig,
    replyResolver: (async () => undefined) as never,
    replyLogger: (overrides.replyLogger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }) as never,
    backgroundTasks: new Set(),
  });
}

function mockCallArg(mockFn: ReturnType<typeof vi.fn>, label: string, callIndex = 0, argIndex = 0) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected ${label} call ${callIndex}`);
  }
  if (!(argIndex in call)) {
    throw new Error(`Expected ${label} call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processMessage group system prompt wiring", () => {
  beforeEach(() => {
    buildContextMock.mockReset();
    dispatchBufferedReplyMock.mockClear();
    isControlCommandMessageMock.mockReset();
    isControlCommandMessageMock.mockReturnValue(false);
    resolvePolicyMock.mockReset();
    replyPlanParamsMock.mockClear();
    runChannelInboundEventParamsMock.mockClear();
    runMessageReceivedMock.mockClear();
    shouldComputeCommandAuthorizedMock.mockReset();
    shouldComputeCommandAuthorizedMock.mockReturnValue(false);
    trackBackgroundTaskMock.mockClear();
    clearInternalHooks();
    buildContextMock.mockImplementation(
      (params: { groupSystemPrompt?: string; combinedBody?: string }) => ({
        GroupSystemPrompt: params.groupSystemPrompt,
        Body: params.combinedBody ?? "",
      }),
    );
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("resolves group systemPrompt from account config and passes it into buildWhatsAppInboundContext", async () => {
    resolvePolicyMock.mockReturnValue(
      makePolicy(makeAccount({ [GROUP_JID]: { systemPrompt: "from config" } })),
    );

    await callProcessMessage();

    expect(
      (
        mockCallArg(buildContextMock, "buildWhatsAppInboundContext") as {
          groupSystemPrompt?: string;
        }
      ).groupSystemPrompt,
    ).toBe("from config");
  });

  it.each([
    {
      name: "marks detected WhatsApp slash messages as text command turns",
      message: { body: "/status" },
      commandBody: "/status",
      isControlCommand: true,
      expectedContext: {
        command: {
          kind: "text-slash",
          authorization: { kind: "authorized" },
          body: "/status",
        },
        rawBody: "/status",
      },
    },
    {
      name: "keeps generated media notices out of command input",
      message: {
        body: "/reset\n\n[whatsapp attachment unavailable]",
        commandBody: "/reset",
      },
      commandBody: "/reset",
      isControlCommand: true,
      expectedContext: {
        bodyForAgent: "/reset\n\n[whatsapp attachment unavailable]",
        command: {
          kind: "text-slash",
          authorization: { kind: "authorized" },
          body: "/reset",
        },
        rawBody: "/reset",
      },
    },
    {
      name: "checks auth for inline command tokens without marking them as command-source turns",
      message: { body: "please inspect `/tmp/foo`" },
      commandBody: "please inspect `/tmp/foo`",
      isControlCommand: false,
      expectedContext: {
        command: {
          kind: "normal",
          authorization: { kind: "authorized" },
          body: "please inspect `/tmp/foo`",
        },
        rawBody: "please inspect `/tmp/foo`",
      },
    },
  ])("$name", async ({ message, commandBody, isControlCommand, expectedContext }) => {
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));
    isControlCommandMessageMock.mockReturnValue(isControlCommand);
    shouldComputeCommandAuthorizedMock.mockReturnValue(true);

    await callProcessMessage({ msg: makeBaseMsg(message) });

    expect(shouldComputeCommandAuthorizedMock).toHaveBeenCalledWith(commandBody, {});
    expect(isControlCommandMessageMock).toHaveBeenCalledWith(commandBody, {});
    expect(mockCallArg(buildContextMock, "buildWhatsAppInboundContext")).toMatchObject(
      expectedContext,
    );
  });

  it("passes pending group history from the history window into inbound context", async () => {
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));
    const groupHistories = new Map<string, unknown[]>([
      [
        "whatsapp:default:group:123@g.us",
        [
          {
            sender: "Alice (+15550002222)",
            body: "quiet pending context",
            timestamp: 1710000000,
            id: "quiet-msg-1",
            senderJid: "15550002222@s.whatsapp.net",
          },
        ],
      ],
    ]);

    await callProcessMessage({ groupHistories });

    expect(mockCallArg(buildContextMock, "buildWhatsAppInboundContext")).toMatchObject({
      groupHistory: [
        {
          sender: "Alice (+15550002222)",
          body: "quiet pending context",
          timestamp: 1710000000,
          id: "quiet-msg-1",
          senderJid: "15550002222@s.whatsapp.net",
        },
      ],
    });
  });

  it("fires message_received hooks with canonical WhatsApp correlation fields", async () => {
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      BodyForCommands: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      From: GROUP_JID,
      To: "+15550001111",
      SessionKey: baseRoute.sessionKey,
      AccountId: "default",
      MessageSid: "msg1",
      SenderId: "+15550002222",
      SenderName: "Alice",
      SenderE164: "+15550002222",
      Timestamp: 1710000000,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SuppressMessageReceivedHooks: true,
      OriginatingChannel: "whatsapp",
      OriginatingTo: GROUP_JID,
      GroupSubject: "Test Group",
    }));

    await callProcessMessage({
      cfg: {
        channels: {
          whatsapp: {
            pluginHooks: {
              messageReceived: true,
            },
          },
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(runMessageReceivedMock).toHaveBeenCalledTimes(1);
    expect(runMessageReceivedMock).toHaveBeenCalledWith(
      {
        from: GROUP_JID,
        content: "hi",
        timestamp: 1710000000,
        threadId: undefined,
        messageId: "msg1",
        senderId: "+15550002222",
        sessionKey: baseRoute.sessionKey,
        runId: undefined,
        metadata: {
          to: "+15550001111",
          provider: "whatsapp",
          surface: "whatsapp",
          threadId: undefined,
          originatingChannel: "whatsapp",
          originatingTo: GROUP_JID,
          messageId: "msg1",
          senderId: "+15550002222",
          senderName: "Alice",
          senderUsername: undefined,
          senderE164: "+15550002222",
          replyToId: undefined,
          replyToIdFull: undefined,
          replyToBody: undefined,
          replyToSender: undefined,
          replyToIsQuote: undefined,
          mediaPath: undefined,
          mediaUrl: undefined,
          mediaType: undefined,
          mediaPaths: undefined,
          mediaUrls: undefined,
          mediaTypes: undefined,
          guildId: undefined,
          groupSubject: "Test Group",
          channelName: undefined,
          topicName: undefined,
        },
      },
      {
        channelId: "whatsapp",
        accountId: "default",
        conversationId: GROUP_JID,
        sessionKey: baseRoute.sessionKey,
        messageId: "msg1",
        senderId: "+15550002222",
      },
    );
    expect(internalReceived).toHaveBeenCalledTimes(1);
    const internalEvent = mockCallArg(internalReceived, "internal message received") as Record<
      string,
      unknown
    >;
    expect(internalEvent.timestamp).toBeInstanceOf(Date);
    expect({ ...internalEvent, timestamp: undefined }).toEqual({
      type: "message",
      action: "received",
      sessionKey: baseRoute.sessionKey,
      context: {
        from: GROUP_JID,
        content: "hi",
        timestamp: 1710000000,
        channelId: "whatsapp",
        accountId: "default",
        conversationId: GROUP_JID,
        messageId: "msg1",
        metadata: {
          to: "+15550001111",
          provider: "whatsapp",
          surface: "whatsapp",
          threadId: undefined,
          senderId: "+15550002222",
          senderName: "Alice",
          senderUsername: undefined,
          senderE164: "+15550002222",
          guildId: undefined,
          channelName: undefined,
          topicName: undefined,
        },
      },
      timestamp: undefined,
      messages: [],
    });
  });

  it("does not double-emit message_received hooks when pre-gate observation already emitted", async () => {
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      SessionKey: baseRoute.sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SuppressMessageReceivedHooks: true,
    }));

    await callProcessMessage({
      cfg: {
        channels: {
          whatsapp: {
            pluginHooks: {
              messageReceived: true,
            },
          },
        },
      },
      messageReceivedEmitted: true,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(runMessageReceivedMock).not.toHaveBeenCalled();
    expect(internalReceived).not.toHaveBeenCalled();
  });

  it("does not fire WhatsApp message_received hooks without explicit opt-in", async () => {
    const internalReceived = vi.fn();
    registerInternalHook("message:received", internalReceived);
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));

    await callProcessMessage();

    expect(runMessageReceivedMock).not.toHaveBeenCalled();
    expect(internalReceived).not.toHaveBeenCalled();
  });

  it("tracks session metadata writes as connection background tasks", async () => {
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      SessionKey: baseRoute.sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
    }));

    await callProcessMessage();

    expect(trackBackgroundTaskMock).toHaveBeenCalledTimes(1);
    expect(mockCallArg(trackBackgroundTaskMock, "trackBackgroundTask")).toBeInstanceOf(Set);
    expect(mockCallArg(trackBackgroundTaskMock, "trackBackgroundTask", 0, 1)).toBeInstanceOf(
      Promise,
    );
  });

  it("passes one lifecycle and owning dispatcher through the portable turn boundary", async () => {
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      SessionKey: baseRoute.sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
    }));
    const lifecycle = {
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(async () => undefined),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(async () => undefined),
    };
    const dispatchReplyFromConfig = vi.fn(async () => ({
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    }));
    const msg = attachWhatsAppIngressLifecycle(makeBaseMsg(), lifecycle as never);

    await callProcessMessage({ msg, dispatchReplyFromConfig });

    const runParams = mockCallArg(runChannelInboundEventParamsMock, "runChannelInboundEvent") as {
      raw?: unknown;
      turnAdoptionLifecycle?: unknown;
    };
    const replyPlanParams = mockCallArg(replyPlanParamsMock, "createWhatsAppReplyPlan") as {
      turnAdoptionLifecycle?: unknown;
    };
    expect(runParams.turnAdoptionLifecycle).toBe(replyPlanParams.turnAdoptionLifecycle);
    expect(dispatchReplyFromConfig).toHaveBeenCalledOnce();
    expect(runParams.raw).not.toHaveProperty("platform");
    expect(runParams.raw).not.toHaveProperty("admission");
  });

  it("drops blocked admission before session record and reply dispatch", async () => {
    resolvePolicyMock.mockReturnValue(makePolicy(makeAccount()));
    buildContextMock.mockImplementationOnce(() => ({
      Body: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      SessionKey: baseRoute.sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
    }));

    const result = await callProcessMessage({
      msg: createTestWebInboundMessage({
        admission: {
          ingress: {
            admission: "drop",
            decision: "block",
            reasonCode: "dm_policy_not_allowlisted",
          },
          senderAccess: {
            allowed: false,
            decision: "block",
            reasonCode: "dm_policy_not_allowlisted",
          },
          activationAccess: {
            allowed: false,
            shouldSkip: true,
            reasonCode: "dm_policy_not_allowlisted",
          },
        },
      }),
    });

    expect(result).toBe(false);
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(trackBackgroundTaskMock).not.toHaveBeenCalled();
    expect(dispatchBufferedReplyMock).not.toHaveBeenCalled();
    expect(runMessageReceivedMock).not.toHaveBeenCalled();
  });
});

describe("processMessage High Brain DM trigger", () => {
  const highBrainRegistrarMock = vi.fn<WhatsAppHighBrainClassificationRegistrar>();

  function makeDmMsg(body: string, eventId = "dm-high-brain-1") {
    return createTestWebInboundMessage({
      event: { id: eventId, timestamp: 1710000000 },
      payload: { body },
      platform: {
        chatJid: "+15550002222",
        recipientJid: "+15550001111",
        senderJid: "15550002222@s.whatsapp.net",
        senderE164: "+15550002222",
        senderName: "Alice",
        sendComposing: async () => {},
        reply: async () => createAcceptedWhatsAppSendResult("text", "r1"),
        sendMedia: async () => createAcceptedWhatsAppSendResult("media", "m1"),
      },
      admission: {
        accountId: "default",
        conversation: { kind: "direct", id: "+15550002222" },
        sender: { id: "+15550002222" },
        senderAccess: { reasonCode: "dm_policy_allowlisted" },
      },
    });
  }

  beforeEach(() => {
    buildContextMock.mockReset();
    resolvePolicyMock.mockReset();
    shouldComputeCommandAuthorizedMock.mockReset();
    shouldComputeCommandAuthorizedMock.mockReturnValue(false);
    isControlCommandMessageMock.mockReset();
    isControlCommandMessageMock.mockReturnValue(false);
    dispatchBufferedReplyMock.mockClear();
    runChannelInboundEventParamsMock.mockClear();
    runMessageReceivedMock.mockClear();
    trackBackgroundTaskMock.mockClear();
    highBrainRegistrarMock.mockClear();
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    setWhatsAppHighBrainClassificationRegistrar(highBrainRegistrarMock);
    buildContextMock.mockImplementation((params: { bodyForAgent?: string }) => ({
      Body: params.bodyForAgent ?? "",
      BodyForAgent: params.bodyForAgent ?? "",
      ChatType: "direct",
      Provider: "whatsapp",
      CommandAuthorized: false,
    }));
  });

  afterEach(() => {
    resetWhatsAppHighBrainClassificationRegistrarForTests();
  });

  it("strips the trigger prefix and registers a one-shot HIGH override for an owner DM", async () => {
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(makeAccount()),
      configuredAllowFrom: ["+15550002222"],
    });
    await callProcessMessage({
      msg: makeDmMsg("Bruno, high brain: Plan the production rollout"),
    });
    const buildParams = mockCallArg(buildContextMock, "buildWhatsAppInboundContext") as {
      bodyForAgent?: string;
    };
    expect(buildParams.bodyForAgent).toBe("Plan the production rollout");
    expect(highBrainRegistrarMock).toHaveBeenCalledTimes(1);
    expect(highBrainRegistrarMock.mock.calls[0]?.[0]).toMatchObject({
      policyVersion: 1,
      mode: "dm",
      requestedTier: "high",
    });
    const builtContext = buildContextMock.mock.results[0]?.value as
      | { BrunoHighBrain?: { sourceEventId: string } }
      | undefined;
    expect(builtContext?.BrunoHighBrain?.sourceEventId).toBeTruthy();
  });

  it("fails closed for an exact non-owner High Brain DM with no privileged or ordinary processing", async () => {
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(makeAccount()),
      configuredAllowFrom: [],
    });
    const msg = makeDmMsg("Bruno, high brain: Plan the production rollout");
    const result = await callProcessMessage({ msg });
    expect(result).toBe(false);
    expect(msg.highBrain).toBeUndefined();
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(dispatchBufferedReplyMock).not.toHaveBeenCalled();
    expect(runChannelInboundEventParamsMock).not.toHaveBeenCalled();
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });

  it("fails closed when the High Brain registrar is unavailable for an exact owner DM", async () => {
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(makeAccount()),
      configuredAllowFrom: ["+15550002222"],
    });
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    const msg = makeDmMsg("Bruno, high brain: Plan the production rollout");
    const result = await callProcessMessage({ msg });
    expect(result).toBe(false);
    expect(msg.highBrain).toBeUndefined();
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(dispatchBufferedReplyMock).not.toHaveBeenCalled();
    expect(runChannelInboundEventParamsMock).not.toHaveBeenCalled();
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });

  it("fails closed when the High Brain registrar throws for an exact owner DM", async () => {
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(makeAccount()),
      configuredAllowFrom: ["+15550002222"],
    });
    const throwing = vi.fn<WhatsAppHighBrainClassificationRegistrar>(() => {
      throw new Error("registrar boom");
    });
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    setWhatsAppHighBrainClassificationRegistrar(throwing);
    const msg = makeDmMsg("Bruno, high brain: Plan the production rollout");
    const result = await callProcessMessage({ msg });
    expect(result).toBe(false);
    expect(msg.highBrain).toBeUndefined();
    expect(buildContextMock).not.toHaveBeenCalled();
    expect(dispatchBufferedReplyMock).not.toHaveBeenCalled();
    expect(runChannelInboundEventParamsMock).not.toHaveBeenCalled();
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("routes the following ordinary DM through normal semantic processing", async () => {
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(makeAccount()),
      configuredAllowFrom: ["+15550002222"],
    });
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    await callProcessMessage({
      msg: makeDmMsg("Bruno, high brain: Plan the production rollout"),
    });
    buildContextMock.mockClear();
    dispatchBufferedReplyMock.mockClear();
    runChannelInboundEventParamsMock.mockClear();

    const result = await callProcessMessage({ msg: makeDmMsg("hello there", "dm-ordinary-1") });
    expect(result).toBe(true);
    expect(mockCallArg(buildContextMock, "buildWhatsAppInboundContext")).toMatchObject({
      bodyForAgent: "hello there",
    });
    expect(dispatchBufferedReplyMock).toHaveBeenCalled();
    expect(runChannelInboundEventParamsMock).toHaveBeenCalled();
  });

  it("isolates concurrent unrelated DMs so neither inherits the other's override", async () => {
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(makeAccount()),
      configuredAllowFrom: ["+15550002222"],
    });
    await Promise.all([
      callProcessMessage({
        msg: makeDmMsg("Bruno, high brain: first query", "dm-concurrent-a"),
      }),
      callProcessMessage({
        msg: makeDmMsg("Bruno, high brain: second query", "dm-concurrent-b"),
      }),
    ]);
    expect(highBrainRegistrarMock).toHaveBeenCalledTimes(2);
    const firstSource = highBrainRegistrarMock.mock.calls[0]?.[0] as
      | { sourceEventId: string }
      | undefined;
    const secondSource = highBrainRegistrarMock.mock.calls[1]?.[0] as
      | { sourceEventId: string }
      | undefined;
    expect(firstSource?.sourceEventId).toBeTruthy();
    expect(secondSource?.sourceEventId).toBeTruthy();
    expect(firstSource?.sourceEventId).not.toBe(secondSource?.sourceEventId);
    const contexts = buildContextMock.mock.results.map(
      (result) => result.value as { BrunoHighBrain?: { sourceEventId: string } } | undefined,
    );
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.BrunoHighBrain?.sourceEventId).toBe(firstSource?.sourceEventId);
    expect(contexts[1]?.BrunoHighBrain?.sourceEventId).toBe(secondSource?.sourceEventId);
  });

  it("does not let a denied attempt poison, block, or authorize a later legitimate event", async () => {
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(makeAccount()),
      configuredAllowFrom: ["+15550002222"],
    });
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    await callProcessMessage({
      msg: makeDmMsg("Bruno, high brain: denied attempt", "dm-denied-1"),
    });
    expect(buildContextMock).not.toHaveBeenCalled();

    setWhatsAppHighBrainClassificationRegistrar(highBrainRegistrarMock);
    buildContextMock.mockClear();
    dispatchBufferedReplyMock.mockClear();
    runChannelInboundEventParamsMock.mockClear();
    const result = await callProcessMessage({
      msg: makeDmMsg("Bruno, high brain: later legitimate query", "dm-later-1"),
    });
    expect(result).toBe(true);
    expect(mockCallArg(buildContextMock, "buildWhatsAppInboundContext")).toMatchObject({
      bodyForAgent: "later legitimate query",
    });
    expect(highBrainRegistrarMock).toHaveBeenCalledTimes(1);
    const builtContext = buildContextMock.mock.results[0]?.value as
      | { BrunoHighBrain?: { sourceEventId: string } }
      | undefined;
    expect(builtContext?.BrunoHighBrain?.sourceEventId).toBeTruthy();
  });

  it("emits only content-free denial evidence for a denied High Brain DM", async () => {
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(makeAccount()),
      configuredAllowFrom: ["+15550002222"],
    });
    resetWhatsAppHighBrainClassificationRegistrarForTests();
    const warn = vi.fn<(obj: unknown, msg: string) => void>();
    await callProcessMessage({
      msg: makeDmMsg("Bruno, high brain: never log this query", "dm-audit-1"),
      replyLogger: { warn },
    });
    expect(warn).toHaveBeenCalled();
    const firstCall = warn.mock.calls[0];
    const evidence = firstCall?.[0] as Record<string, unknown> | undefined;
    expect(evidence).toMatchObject({ reason: "high_brain_registration_unavailable" });
    expect(Object.keys(evidence ?? {})).toEqual(["reason"]);
    const logged = JSON.stringify([firstCall?.[0], firstCall?.[1]]);
    expect(logged).not.toContain("never log this query");
    expect(logged).not.toContain("+15550002222");
    expect(logged).not.toContain("dm-audit-1");
    expect(logged).not.toContain("token");
  });

  it("does not activate a malformed DM trigger", async () => {
    resolvePolicyMock.mockReturnValue({
      ...makePolicy(makeAccount()),
      configuredAllowFrom: ["+15550002222"],
    });
    await callProcessMessage({ msg: makeDmMsg("Bruno, high brain:") });
    expect(highBrainRegistrarMock).not.toHaveBeenCalled();
  });
});
