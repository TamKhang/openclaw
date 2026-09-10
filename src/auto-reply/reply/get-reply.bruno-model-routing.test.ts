import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

const LEGACY_PRIMARY = { provider: "openrouter", model: "openrouter/free" };

const deepseekFlash: BrunoModelRouterDecision = {
  reason: "selected",
  selectedModel: { provider: "deepseek", model: "deepseek-v4-flash" },
  policyVersion: "model-router-v0.1",
  fallbackAlternatives: [{ provider: "google", model: "gemini-3.8-flash" }],
  classification: { taskType: "reasoning", complexity: "medium", riskLevel: "low" },
};

const geminiFlash: BrunoModelRouterDecision = {
  reason: "selected",
  selectedModel: { provider: "google", model: "gemini-3.8-flash" },
  policyVersion: "model-router-v0.1",
  fallbackAlternatives: [{ provider: "deepseek", model: "deepseek-v4-flash" }],
  classification: { taskType: "reasoning", complexity: "medium", riskLevel: "low" },
};

function createConfig(storePath: string, workspaceDir: string): OpenClawConfig {
  return markCompleteReplyConfig({
    session: { store: storePath },
    agents: {
      defaults: {
        model: {
          primary: `${LEGACY_PRIMARY.provider}/${LEGACY_PRIMARY.model}`,
          fallbacks: ["openrouter/openrouter/free"],
        },
        modelPolicy: { allow: ["*/*"] },
        workspace: workspaceDir,
      },
    },
  } as OpenClawConfig);
}

async function runWhatsAppDm(params: {
  body: string;
  senderIsOwner?: boolean;
  senderIsAuthorized?: boolean;
}): Promise<unknown> {
  const { body, senderIsOwner = true, senderIsAuthorized = true } = params;
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
      senderIsOwner,
      resetHookTriggered: false,
      provider: params.provider,
      model: params.model,
    });
    result.result.command.isAuthorizedSender = senderIsAuthorized;
    result.result.command.senderIsOwner = senderIsOwner;
    return result;
  });
  mocks.handleInlineActions.mockImplementation(async () => ({
    kind: "continue",
    directives: {},
    cleanedBody: body,
    abortedLastRun: false,
  }));
  return await getReplyFromConfig(
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
    label: "bruno-routing-reply",
    env: { OPENCLAW_TEST_FAST: undefined },
  });
  const actualModelSelection = await vi.importActual<
    typeof import("../../agents/model-selection.js")
  >("../../agents/model-selection.js");
  vi.mocked(resolveModelRefFromStringMock).mockImplementation(
    actualModelSelection.resolveModelRefFromString,
  );
  vi.mocked(resolveDefaultModelMock).mockReturnValue({
    defaultProvider: LEGACY_PRIMARY.provider,
    defaultModel: LEGACY_PRIMARY.model,
    aliasIndex: actualModelSelection.buildModelAliasIndex({
      cfg: {},
      defaultProvider: LEGACY_PRIMARY.provider,
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

describe("Bruno model routing in the ordinary reply path", () => {
  it("A: asks Bruno before provider execution and uses the selected route", async () => {
    process.env.OPENCLAW_BRUNO_MODEL_ROUTING = "1";
    const sequence: string[] = [];
    setBrunoModelRouter({
      route: () => {
        sequence.push("bruno-route");
        return deepseekFlash;
      },
    });
    vi.mocked(runPreparedReplyMock).mockImplementation(async () => {
      sequence.push("run-prepared");
      return { text: "ok" };
    });
    await runWhatsAppDm({ body: "hello" });
    expect(sequence).toEqual(["bruno-route", "run-prepared"]);
    expect(runPreparedReplyMock).toHaveBeenCalledTimes(1);
    const params = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(params).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      brunoApprovedFallbacks: ["google/gemini-3.8-flash"],
    });
  });

  it("B: a medium-complexity eligible request reaches deepseek-v4-flash", async () => {
    process.env.OPENCLAW_BRUNO_MODEL_ROUTING = "1";
    setBrunoModelRouter({ route: () => deepseekFlash });
    await runWhatsAppDm({ body: "x".repeat(600) });
    expect(vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
  });

  it("C: an eligible Gemini route reaches Gemini unchanged", async () => {
    process.env.OPENCLAW_BRUNO_MODEL_ROUTING = "1";
    setBrunoModelRouter({ route: () => geminiFlash });
    await runWhatsAppDm({ body: "hello" });
    expect(vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0]).toMatchObject({
      provider: "google",
      model: "gemini-3.8-flash",
    });
  });

  it("D: openrouter/free executes only when Bruno policy selects it", async () => {
    process.env.OPENCLAW_BRUNO_MODEL_ROUTING = "1";
    setBrunoModelRouter({
      route: () => ({
        reason: "selected",
        selectedModel: { provider: "openrouter", model: "openrouter/free" },
        policyVersion: "model-router-v0.1",
        fallbackAlternatives: [],
        classification: { taskType: "reasoning", complexity: "low", riskLevel: "low" },
      }),
    });
    await runWhatsAppDm({ body: "hello" });
    expect(vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0]).toMatchObject({
      provider: "openrouter",
      model: "openrouter/free",
    });
  });

  it("E: high-complexity/high-risk turns fail closed instead of defaulting to openrouter/free", async () => {
    process.env.OPENCLAW_BRUNO_MODEL_ROUTING = "1";
    setBrunoModelRouter({
      route: () => ({
        reason: "no_acceptable_model",
        selectedModel: null,
        fallbackAlternatives: [],
        classification: { taskType: "reasoning", complexity: "high", riskLevel: "high" },
      }),
    });
    const reply = await runWhatsAppDm({
      body: "x".repeat(1600),
      senderIsOwner: false,
      senderIsAuthorized: false,
    });
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
    expect(reply).toEqual({
      text: "Model routing is unavailable right now and no governed fallback was selected, so this message was not answered automatically.",
    });
  });

  it("F: router failure follows the fail-closed contract", async () => {
    process.env.OPENCLAW_BRUNO_MODEL_ROUTING = "1";
    setBrunoModelRouter({
      route: () => {
        throw new Error("bruno router down");
      },
    });
    const reply = await runWhatsAppDm({ body: "hello" });
    expect(runPreparedReplyMock).not.toHaveBeenCalled();
    expect(reply).toEqual({
      text: "Model routing is unavailable right now and no governed fallback was selected, so this message was not answered automatically.",
    });
  });

  it("H: legacy agents.defaults.model.primary does not bypass Bruno inside scope", async () => {
    process.env.OPENCLAW_BRUNO_MODEL_ROUTING = "1";
    setBrunoModelRouter({ route: () => deepseekFlash });
    await runWhatsAppDm({ body: "hello" });
    const params = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(params?.provider).toBe("deepseek");
    expect(params?.model).toBe("deepseek-v4-flash");
    expect(params?.provider).not.toBe(LEGACY_PRIMARY.provider);
  });

  it("I: legacy OpenClaw routing stays unchanged when the DEV gate is off", async () => {
    setBrunoModelRouter({ route: () => deepseekFlash });
    await runWhatsAppDm({ body: "hello" });
    const params = vi.mocked(runPreparedReplyMock).mock.calls[0]?.[0];
    expect(params).toMatchObject({
      provider: LEGACY_PRIMARY.provider,
      model: LEGACY_PRIMARY.model,
    });
    expect(params?.brunoApprovedFallbacks).toBeUndefined();
  });
});
