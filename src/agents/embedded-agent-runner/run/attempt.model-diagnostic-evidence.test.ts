import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDiagnosticEventsForTest } from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { EVIDENCE_SENTINEL_MARKER } from "../../provenance/answer-evidence.js";
import { wrapStreamFnWithDiagnosticModelCallEvents } from "./attempt.model-diagnostic-events.js";

function assistantFixture(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "accepted answer" }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

function wrapSingleCall(result: unknown) {
  const originalStream = {
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
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents((() => originalStream) as never, {
    runId: "run-evidence",
    provider: "openai",
    model: "gpt-5.4",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => "call_1",
  });
  return wrapped;
}

describe("answer-evidence projection at the model-call stamping boundary", () => {
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

  it("strips the sentinel and materializes the hidden block on the same terminal message", async () => {
    const wrapped = wrapSingleCall(
      assistantFixture({
        content: [{ type: "text", text: `answer\n${EVIDENCE_SENTINEL_MARKER}["ev_1","ev_2"]` }],
      }),
    );
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ content: Array<Record<string, unknown>>; openclawCallId?: string }>;
    };
    const result = await stream.result();
    expect(result.openclawCallId).toBe("call_1");
    expect(result.content).toEqual([
      { type: "text", text: "answer\n" },
      { type: "openclawProvenance", usedEvidenceIds: ["ev_1", "ev_2"] },
    ]);
  });

  it("strips a malformed terminal sentinel but materializes no block", async () => {
    const wrapped = wrapSingleCall(
      assistantFixture({
        content: [{ type: "text", text: `answer\n${EVIDENCE_SENTINEL_MARKER}["ev_1"` }],
      }),
    );
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ content: Array<Record<string, unknown>> }>;
    };
    const result = await stream.result();
    expect(result.content).toEqual([{ type: "text", text: "answer\n" }]);
  });

  it("does not materialize a block on stopReason=error with a valid sentinel", async () => {
    const wrapped = wrapSingleCall(
      assistantFixture({
        stopReason: "error",
        errorMessage: "provider failure",
        content: [
          {
            type: "text",
            text: `answer
${EVIDENCE_SENTINEL_MARKER}["ev_1"]`,
          },
        ],
      }),
    );
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ content: Array<Record<string, unknown>> }>;
    };
    const result = await stream.result();
    expect(result.content.some((block) => block.type === "openclawProvenance")).toBe(false);
  });

  it("does not materialize a block on stopReason=aborted with a valid sentinel", async () => {
    const wrapped = wrapSingleCall(
      assistantFixture({
        stopReason: "aborted",
        content: [
          {
            type: "text",
            text: `answer
${EVIDENCE_SENTINEL_MARKER}["ev_1"]`,
          },
        ],
      }),
    );
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ content: Array<Record<string, unknown>> }>;
    };
    const result = await stream.result();
    expect(result.content.some((block) => block.type === "openclawProvenance")).toBe(false);
  });

  it("does not materialize a block on a tool-use predecessor (non-terminal)", async () => {
    const wrapped = wrapSingleCall(
      assistantFixture({
        stopReason: "toolUse",
        content: [
          { type: "text", text: "searching..." },
          { type: "toolCall", id: "t1", name: "search", arguments: {} },
        ],
      }),
    );
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ content: Array<Record<string, unknown>> }>;
    };
    const result = await stream.result();
    expect(result.content.some((block) => block.type === "openclawProvenance")).toBe(false);
  });

  it("leaves text unchanged when no sentinel is present", async () => {
    const wrapped = wrapSingleCall(
      assistantFixture({ content: [{ type: "text", text: "plain answer" }] }),
    );
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ content: Array<Record<string, unknown>> }>;
    };
    const result = await stream.result();
    expect(result.content).toEqual([{ type: "text", text: "plain answer" }]);
  });

  it("extracts from the final-answer text block when a commentary block precedes it", async () => {
    const commentarySignature = JSON.stringify({ v: 1, id: "rs_c", phase: "commentary" });
    const finalSignature = JSON.stringify({ v: 1, id: "rs_f", phase: "final_answer" });
    const wrapped = wrapSingleCall(
      assistantFixture({
        content: [
          { type: "text", text: "thinking out loud", textSignature: commentarySignature },
          {
            type: "text",
            text: `answer\n${EVIDENCE_SENTINEL_MARKER}["ev_1"]`,
            textSignature: finalSignature,
          },
        ],
      }),
    );
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ content: Array<Record<string, unknown>> }>;
    };
    const result = await stream.result();
    expect(result.content).toEqual([
      { type: "text", text: "thinking out loud", textSignature: commentarySignature },
      { type: "text", text: "answer\n", textSignature: finalSignature },
      { type: "openclawProvenance", usedEvidenceIds: ["ev_1"] },
    ]);
  });

  it("treats a mid-line marker as ordinary text and produces no projection", async () => {
    const wrapped = wrapSingleCall(
      assistantFixture({
        content: [{ type: "text", text: `text ${EVIDENCE_SENTINEL_MARKER}["ev_1"]` }],
      }),
    );
    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ content: Array<Record<string, unknown>> }>;
    };
    const result = await stream.result();
    expect(result.content).toEqual([
      { type: "text", text: `text ${EVIDENCE_SENTINEL_MARKER}["ev_1"]` },
    ]);
  });
});
