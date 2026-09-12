import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeGoogleAssistantMessage } from "../../../../packages/ai/src/providers/google-shared.test-helpers.js";
import {
  createAssistantOutput,
  createDeepSeekCompletionsModel,
} from "../../../../packages/ai/src/transports/openai-completions.test-support.js";
import { resetDiagnosticEventsForTest } from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { extractAssistantVisibleText } from "../../embedded-agent-utils.js";
import { EVIDENCE_SENTINEL_MARKER } from "../../provenance/answer-evidence.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

type StampedResult = {
  content: Array<Record<string, unknown>>;
  openclawCallId?: string;
  api?: string;
  provider?: string;
};

function wrapFixture(result: unknown) {
  const stream = {
    [Symbol.asyncIterator]() {
      let yielded = false;
      return {
        async next() {
          if (!yielded) {
            yielded = true;
            return { value: { type: "text_delta", contentIndex: 0, delta: "ok" }, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
    result: vi.fn(async () => result),
  };
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents((() => stream) as never, {
    runId: "run-provider-evidence",
    provider: "openai",
    model: "gpt-5.4",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => "call_1",
  });
  return wrapped({} as never, {} as never, {} as never) as unknown as {
    result: () => Promise<StampedResult>;
  };
}

const SENTINEL = `${EVIDENCE_SENTINEL_MARKER}["ev_1","ev_2"]`;

describe("provider-path certification of the normalized Gate 2D mechanism", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticRunActivityForTest();
    startDiagnosticRunActivityTracking();
    resetGlobalHookRunner();
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticRunActivityForTest();
    resetGlobalHookRunner();
    vi.restoreAllMocks();
  });

  it("OpenAI Responses: commentary + final-answer blocks converge on clean text + hidden projection", async () => {
    const commentarySignature = JSON.stringify({ v: 1, id: "rs_c", phase: "commentary" });
    const finalSignature = JSON.stringify({ v: 1, id: "rs_f", phase: "final_answer" });
    const fixture = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4",
      stopReason: "stop",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1,
      content: [
        { type: "text", text: "thinking out loud", textSignature: commentarySignature },
        { type: "text", text: `answer\n${SENTINEL}`, textSignature: finalSignature },
      ],
    };
    const result = await wrapFixture(fixture).result();
    expect(result.openclawCallId).toBe("call_1");
    expect(extractAssistantVisibleText(result as never)).toBe("answer");
    expect(result.content).toEqual([
      { type: "text", text: "thinking out loud", textSignature: commentarySignature },
      { type: "text", text: "answer\n", textSignature: finalSignature },
      { type: "openclawProvenance", usedEvidenceIds: ["ev_1", "ev_2"] },
    ]);
  });

  it("OpenAI-completions (DeepSeek/OpenRouter normalized shape) converges on clean text + hidden projection", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    output.content = [{ type: "text", text: `answer\n${SENTINEL}` }] as never;
    const result = await wrapFixture(output).result();
    expect(result.openclawCallId).toBe("call_1");
    expect(result.api).toBe("openai-completions");
    expect(result.provider).toBe("deepseek");
    expect(extractAssistantVisibleText(result as never)).toBe("answer");
    expect(result.content).toEqual([
      { type: "text", text: "answer\n" },
      { type: "openclawProvenance", usedEvidenceIds: ["ev_1", "ev_2"] },
    ]);
  });

  it("Gemini (google-generative-ai normalized shape) converges on clean text + hidden projection", async () => {
    const fixture = makeGoogleAssistantMessage("gemini-3-pro", [
      { type: "text", text: `answer\n${SENTINEL}` },
    ]);
    const result = await wrapFixture(fixture).result();
    expect(result.openclawCallId).toBe("call_1");
    expect(result.api).toBe("google-generative-ai");
    expect(result.provider).toBe("google");
    expect(extractAssistantVisibleText(result as never)).toBe("answer");
    expect(result.content).toEqual([
      { type: "text", text: "answer\n" },
      { type: "openclawProvenance", usedEvidenceIds: ["ev_1", "ev_2"] },
    ]);
  });

  it("malformed sentinel through a provider-normalized completions path fails closed", async () => {
    const model = createDeepSeekCompletionsModel();
    const output = createAssistantOutput(model);
    output.content = [
      { type: "text", text: `answer\n${EVIDENCE_SENTINEL_MARKER}["ev_1"` },
    ] as never;
    const result = await wrapFixture(output).result();
    expect(result.openclawCallId).toBe("call_1");
    expect(extractAssistantVisibleText(result as never)).toBe("answer");
    expect(result.content.some((block) => block.type === "openclawProvenance")).toBe(false);
    expect(JSON.stringify(result.content)).not.toContain("ev_1");
  });
});
