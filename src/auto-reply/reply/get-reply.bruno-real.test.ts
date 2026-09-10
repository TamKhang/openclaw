import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createBrunoBrainModelRouter,
  setBrunoModelRouter,
  type BrunoModelRouterDecision,
} from "../../agents/bruno-model-routing.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { markCompleteReplyConfig } from "./get-reply-fast-path.test-support.js";
import {
  buildGetReplyCtx,
  createGetReplyContinueDirectivesResult,
  createGetReplySessionState,
  registerGetReplyBaselineBypass,
  registerGetReplyRuntimeOverrides,
} from "./get-reply.test-fixtures.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
}));

registerGetReplyBaselineBypass();
registerGetReplyRuntimeOverrides(mocks);

let state: OpenClawTestState;
let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
let resolveDefaultModelMock: typeof import("./directive-handling.defaults.js").resolveDefaultModel;
let resolveModelRefFromStringMock: typeof import("../../agents/model-selection.js").resolveModelRefFromString;
let runPreparedReplyMock: typeof import("./get-reply-run.js").runPreparedReply;

const brunoBrainModelRouterDist =
  process.env.OPENCLAW_BRUNO_BRAIN_DIST ??
  path.resolve(process.cwd(), "../../Bruno/bruno-brain/dist/src/model-router/index.js");

function createConfig(storePath: string, workspaceDir: string): OpenClawConfig {
  return markCompleteReplyConfig({
    session: { store: storePath },
    agents: {
      defaults: {
        model: { primary: "openrouter/openrouter/free" },
        modelPolicy: { allow: ["*/*"] },
        workspace: workspaceDir,
      },
    },
  } as OpenClawConfig);
}

beforeAll(async () => {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  ({ resolveDefaultModel: resolveDefaultModelMock } =
    await import("./directive-handling.defaults.js"));
  ({ resolveModelRefFromString: resolveModelRefFromStringMock } =
    await import("../../agents/model-selection.js"));
  ({ runPreparedReply: runPreparedReplyMock } = await import("./get-reply-run.js"));
});

beforeEach(async () => {
  state = await createOpenClawTestState({
    label: "bruno-real-e2e",
    env: { OPENCLAW_TEST_FAST: undefined },
  });
  const actualModelSelection = await vi.importActual<
    typeof import("../../agents/model-selection.js")
  >("../../agents/model-selection.js");
  vi.mocked(resolveModelRefFromStringMock).mockImplementation(
    actualModelSelection.resolveModelRefFromString,
  );
  vi.mocked(resolveDefaultModelMock).mockReturnValue({
    defaultProvider: "openrouter",
    defaultModel: "openrouter/free",
    aliasIndex: actualModelSelection.buildModelAliasIndex({
      cfg: {},
      defaultProvider: "openrouter",
    }),
  });
  vi.mocked(runPreparedReplyMock).mockClear();
  vi.mocked(runPreparedReplyMock).mockResolvedValue({ text: "ok" });
});

afterEach(async () => {
  delete process.env.OPENCLAW_BRUNO_MODEL_ROUTING;
  setBrunoModelRouter(null);
  await state.cleanup();
});

describe("real Bruno Brain ordinary-turn end-to-end proof", () => {
  it("routes a WhatsApp-equivalent turn through the real Bruno Brain and admits only Bruno candidates", async () => {
    process.env.OPENCLAW_BRUNO_MODEL_ROUTING = "1";
    const realRouter = await createBrunoBrainModelRouter({
      moduleSpecifier: brunoBrainModelRouterDist,
      load: async () => import(pathToFileURL(brunoBrainModelRouterDist).href),
    });
    expect(realRouter).not.toBeNull();

    let capturedDecision: BrunoModelRouterDecision | undefined;
    let capturedTraceId: string | undefined;
    let capturedCorrelationId: string | undefined;
    setBrunoModelRouter({
      route: async (facts, context) => {
        capturedTraceId = context.traceId;
        capturedCorrelationId = context.correlationId;
        capturedDecision = await realRouter!.route(facts, context);
        return capturedDecision;
      },
    });

    const body = "hello";
    const sessionKey = "agent:main:whatsapp:123";
    const sessionEntry = {};
    const sessionStore = { [sessionKey]: sessionEntry };
    mocks.initSessionState.mockResolvedValue(
      createGetReplySessionState({
        sessionCtx: {},
        sessionEntry,
        sessionStore,
        sessionKey,
        sessionId: "session-1",
        storePath: state.root + "/sessions.json",
        isGroup: false,
        triggerBodyNormalized: body,
        bodyStripped: body,
      }),
    );
    mocks.resolveReplyDirectives.mockImplementation(async (input: unknown) => {
      const params = input as { provider: string; model: string; sessionKey: string };
      const result = createGetReplyContinueDirectivesResult({
        body,
        abortKey: params.sessionKey,
        from: "whatsapp:user:42",
        to: "whatsapp:123",
        senderId: "whatsapp:user:42",
        commandSource: "text",
        senderIsOwner: true,
        resetHookTriggered: false,
        provider: params.provider,
        model: params.model,
      });
      result.result.command.isAuthorizedSender = true;
      result.result.command.senderIsOwner = true;
      return result;
    });
    mocks.handleInlineActions.mockImplementation(async () => ({
      kind: "continue",
      directives: {},
      cleanedBody: body,
      abortedLastRun: false,
    }));

    await getReplyFromConfig(
      buildGetReplyCtx({
        Provider: "whatsapp",
        Surface: "whatsapp",
        OriginatingChannel: "whatsapp",
        ChatType: "direct",
        SessionKey: sessionKey,
        From: "whatsapp:user:42",
        To: "whatsapp:123",
        Body: body,
        BodyForAgent: body,
        RawBody: body,
        CommandBody: body,
      }),
      undefined,
      createConfig(state.root + "/sessions.json", state.root + "/workspace"),
    );

    expect(capturedDecision).toBeDefined();
    expect(capturedDecision?.selectedModel).not.toBeNull();
    expect(capturedTraceId).toBeTruthy();
    expect(capturedCorrelationId).toBe(sessionKey);

    const params = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(params?.provider).toBe(capturedDecision?.selectedModel?.provider);
    expect(params?.model).toBe(capturedDecision?.selectedModel?.model);
    expect(params?.brunoApprovedFallbacks).toEqual(
      capturedDecision?.fallbackAlternatives?.map(
        (candidate) => `${candidate.provider}/${candidate.model}`,
      ),
    );

    // The same classification must be used for the decision and the admitted run.
    expect(capturedDecision?.classification).toBeDefined();
    expect(capturedDecision?.classification?.complexity).toBe("low");
    expect(capturedDecision?.classification?.riskLevel).toBe("low");
  });
});
