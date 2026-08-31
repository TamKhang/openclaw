// WhatsApp tests cover pre-group-gating `message_received` observation wiring.
import { beforeEach, describe, expect, it, vi } from "vitest";

const processMessageMock = vi.hoisted(() => vi.fn());
const maybeBroadcastMessageMock = vi.hoisted(() => vi.fn());
const applyGroupGatingMock = vi.hoisted(() => vi.fn());
const emitPreGateGroupObservationMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => undefined),
);
const maybeSendAckReactionMock = vi.hoisted(() => vi.fn());
const createStatusReactionControllerMock = vi.hoisted(() => vi.fn());
const updateLastRouteInBackgroundMock = vi.hoisted(() => vi.fn());
const resolveConfiguredBindingRouteMock = vi.hoisted(() => vi.fn());
const ensureConfiguredBindingRouteReadyMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/conversation-binding-runtime", () => ({
  resolveConfiguredBindingRoute: (...args: unknown[]) => resolveConfiguredBindingRouteMock(...args),
  ensureConfiguredBindingRouteReady: (...args: unknown[]) =>
    ensureConfiguredBindingRouteReadyMock(...args),
}));

vi.mock("openclaw/plugin-sdk/routing", () => ({
  buildGroupHistoryKey: () => "group-key",
  resolveAgentRoute: () => ({
    agentId: "main",
    accountId: "default",
    sessionKey: "agent:main:whatsapp:group:+15550000002",
    mainSessionKey: "agent:main:main",
  }),
}));

vi.mock("../../accounts.js", () => ({
  resolveWhatsAppAccount: () => ({
    accountId: "default",
    authDir: "/tmp/auth",
    mentionPatterns: [],
    selfChatMode: false,
  }),
}));

vi.mock("../../group-session-key.js", () => ({
  resolveWhatsAppGroupSessionRoute: (route: unknown) => route,
}));

vi.mock("../../identity.js", () => ({
  getPrimaryIdentityId: () => undefined,
  getSenderIdentity: () => ({ e164: "+15550000002", name: "Alice" }),
}));

vi.mock("../../text-runtime.js", () => ({
  normalizeE164: (value: string) => value,
}));

vi.mock("./ack-reaction.js", () => ({
  maybeSendAckReaction: (...args: unknown[]) => maybeSendAckReactionMock(...args),
}));

vi.mock("./broadcast.js", () => ({
  maybeBroadcastMessage: (...args: unknown[]) => maybeBroadcastMessageMock(...args),
}));

vi.mock("./group-gating.js", () => ({
  applyGroupGating: (...args: unknown[]) => applyGroupGatingMock(...args),
}));

vi.mock("./last-route.js", () => ({
  updateLastRouteInBackground: (...args: unknown[]) => updateLastRouteInBackgroundMock(...args),
}));

vi.mock("./peer.js", () => ({
  resolvePeerId: (msg: { admission: { conversation: { id: string } } }) =>
    msg.admission.conversation.id,
}));

vi.mock("./process-message.js", () => ({
  processMessage: (...args: unknown[]) => processMessageMock(...args),
}));

vi.mock("./pre-gate-observation.js", () => ({
  emitPreGateWhatsAppGroupObservation: (...args: unknown[]) =>
    emitPreGateGroupObservationMock(...args),
}));

vi.mock("./status-reaction.js", () => ({
  createWhatsAppStatusReactionController: (...args: unknown[]) =>
    createStatusReactionControllerMock(...args),
}));

import { createTestWebInboundMessage } from "../../inbound/test-message.test-helper.js";
import type { WebInboundMessage } from "../../inbound/types.js";
import { createWebOnMessageHandler } from "./on-message.js";

function makeGroupMessage(): WebInboundMessage {
  return createTestWebInboundMessage({
    admission: {
      conversation: {
        kind: "group",
        id: "1203630@g.us",
      },
      senderAccess: {
        reasonCode: "group_policy_allowed",
      },
    },
    platform: {
      chatJid: "1203630@g.us",
      recipientJid: "+15550000001",
    },
    wasMentioned: false,
  });
}

function makeDirectMessage(): WebInboundMessage {
  return createTestWebInboundMessage();
}

function makeBlockedGroupMessage(): WebInboundMessage {
  return createTestWebInboundMessage({
    admission: {
      conversation: {
        kind: "group",
        id: "1203630@g.us",
      },
      ingress: {
        admission: "drop",
        decision: "block",
        reasonCode: "group_policy_not_allowlisted",
      },
      senderAccess: {
        allowed: false,
        decision: "block",
        reasonCode: "group_policy_not_allowlisted",
      },
      activationAccess: {
        allowed: false,
        shouldSkip: true,
        reasonCode: "group_policy_not_allowlisted",
      },
    },
    platform: {
      chatJid: "1203630@g.us",
      recipientJid: "+15550000001",
    },
  });
}

function makeEchoTracker() {
  return {
    has: () => false,
    forget: () => {},
    rememberText: () => {},
    buildCombinedKey: (p: { combinedBody: string }) => p.combinedBody,
  };
}

function makeHandler() {
  return createWebOnMessageHandler({
    cfg: {} as never,
    verbose: false,
    connectionId: "conn-1",
    maxMediaBytes: 1024 * 1024,
    groupHistoryLimit: 20,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: makeEchoTracker() as never,
    backgroundTasks: new Set(),
    replyResolver: vi.fn() as never,
    replyLogger: {
      info: () => {},
      warn: () => {},
      debug: () => {},
      error: () => {},
    } as never,
    baseMentionConfig: {} as never,
    account: { authDir: "/tmp/auth", accountId: "default" },
  });
}

describe("createWebOnMessageHandler pre-gating WhatsApp observation", () => {
  beforeEach(() => {
    processMessageMock.mockReset();
    processMessageMock.mockResolvedValue(true);
    maybeBroadcastMessageMock.mockReset();
    maybeBroadcastMessageMock.mockResolvedValue(false);
    applyGroupGatingMock.mockReset();
    applyGroupGatingMock.mockResolvedValue({ shouldProcess: true });
    emitPreGateGroupObservationMock.mockReset();
    emitPreGateGroupObservationMock.mockResolvedValue(undefined);
    maybeSendAckReactionMock.mockReset();
    maybeSendAckReactionMock.mockResolvedValue(null);
    createStatusReactionControllerMock.mockReset();
    createStatusReactionControllerMock.mockResolvedValue(null);
    updateLastRouteInBackgroundMock.mockReset();
    resolveConfiguredBindingRouteMock.mockReset();
    resolveConfiguredBindingRouteMock.mockImplementation(({ route }: { route: unknown }) => ({
      bindingResolution: null,
      route,
    }));
    ensureConfiguredBindingRouteReadyMock.mockReset();
    ensureConfiguredBindingRouteReadyMock.mockResolvedValue({ ok: true });
  });

  it("emits group observation exactly once and skips dispatch for an unmentioned group message", async () => {
    applyGroupGatingMock.mockResolvedValue({ shouldProcess: false });
    const handler = makeHandler();

    await handler(makeGroupMessage());

    expect(emitPreGateGroupObservationMock).toHaveBeenCalledTimes(1);
    expect(applyGroupGatingMock).toHaveBeenCalledTimes(1);
    expect(maybeSendAckReactionMock).not.toHaveBeenCalled();
    expect(createStatusReactionControllerMock).not.toHaveBeenCalled();
    expect(maybeBroadcastMessageMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });

  it("emits group observation exactly once and continues normal dispatch for a mentioned group message", async () => {
    const handler = makeHandler();

    await handler(makeGroupMessage());

    expect(emitPreGateGroupObservationMock).toHaveBeenCalledTimes(1);
    expect(applyGroupGatingMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock.mock.calls[0]?.[0]).toMatchObject({
      messageReceivedEmitted: true,
    });
  });

  it("preserves DM behavior and does not emit pre-gating group observation", async () => {
    const handler = makeHandler();

    await handler(makeDirectMessage());

    expect(emitPreGateGroupObservationMock).not.toHaveBeenCalled();
    expect(processMessageMock).toHaveBeenCalledTimes(1);
    expect(processMessageMock.mock.calls[0]?.[0]).not.toMatchObject({
      messageReceivedEmitted: true,
    });
  });

  it("does not observe inbound messages rejected by basic channel authorization", async () => {
    const handler = makeHandler();

    await handler(makeBlockedGroupMessage());

    expect(emitPreGateGroupObservationMock).not.toHaveBeenCalled();
    expect(applyGroupGatingMock).not.toHaveBeenCalled();
    expect(processMessageMock).not.toHaveBeenCalled();
  });
});
