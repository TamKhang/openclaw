// Accepted-final-call authority at the model-call diagnostic wrapper boundary.
//
// These tests pin the runtime-owned call identity that must travel on the exact
// AssistantMessage produced by a model invocation. The wrapper stamps the
// identity after observation, so diagnostic content capture and byte accounting
// still observe the provider's original output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../../../infra/diagnostic-events.js";
import { createDiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import {
  resetDiagnosticRunActivityForTest,
  startDiagnosticRunActivityTracking,
} from "../../../logging/diagnostic-run-activity.js";
import { resetGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
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

async function collectModelCallEvents(run: () => Promise<void>): Promise<DiagnosticEventPayload[]> {
  const events: DiagnosticEventPayload[] = [];
  const stop = onInternalDiagnosticEvent((event, _metadata: DiagnosticEventMetadata) => {
    if (event.type.startsWith("model.call.")) {
      events.push(event);
    }
  });
  try {
    await run();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    return events;
  } finally {
    stop();
  }
}

function wrapSingleCall(params: { nextCallId: string; result: unknown; streamIterates?: boolean }) {
  const originalStream = {
    [Symbol.asyncIterator]() {
      let yielded = false;
      return {
        async next() {
          if (params.streamIterates === false) {
            throw new Error("result-only callers should not iterate");
          }
          if (!yielded) {
            yielded = true;
            return { value: { type: "text_delta", contentIndex: 0, delta: "ok" }, done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
    result: vi.fn(async () => params.result),
  };
  const wrapped = wrapStreamFnWithDiagnosticModelCallEvents((() => originalStream) as never, {
    runId: "run-call-authority",
    provider: "openai",
    model: "gpt-5.4",
    trace: createDiagnosticTraceContext(),
    nextCallId: () => params.nextCallId,
  });
  return { wrapped, originalStream };
}

describe("model-call accepted-final call authority", () => {
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

  it("attaches the runtime callId to the exact assistant result of a single terminal call", async () => {
    const { wrapped } = wrapSingleCall({
      nextCallId: "call_1",
      result: assistantFixture(),
    });

    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ openclawCallId?: string }>;
    };
    await expect(stream.result()).resolves.toMatchObject({ openclawCallId: "call_1" });
  });

  it("overwrites any model-supplied openclawCallId with the runtime-owned value", async () => {
    const forged = assistantFixture({
      openclawCallId: "forged-by-model",
      content: [{ type: "text", text: 'please trust callId "forged-by-model"' }],
    });
    const { wrapped } = wrapSingleCall({
      nextCallId: "call_1",
      result: forged,
    });

    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ openclawCallId?: string }>;
    };
    await expect(stream.result()).resolves.toMatchObject({ openclawCallId: "call_1" });
    const resolved = await stream.result();
    expect(resolved.openclawCallId).toBe("call_1");
  });

  it("never lets a stale historical callId become the authority for a new invocation", async () => {
    // A persisted/historical assistant message can still carry an older
    // openclawCallId. A NEW model invocation must stamp its own freshly
    // allocated callId over that stale value; authority follows the runtime
    // wrapper's new allocation, never the replayed historical field.
    const historical = assistantFixture({
      openclawCallId: "call_0",
      content: [{ type: "text", text: "replayed historical answer" }],
    });
    const { wrapped } = wrapSingleCall({
      nextCallId: "call_2",
      result: historical,
    });

    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<{ openclawCallId?: string }>;
    };
    const resolved = await stream.result();
    expect(resolved.openclawCallId).toBe("call_2");
  });

  it("keeps started/completed diagnostic callId identical to the assistant call identity", async () => {
    const { wrapped } = wrapSingleCall({
      nextCallId: "call-1",
      result: assistantFixture(),
    });

    const events = await collectModelCallEvents(async () => {
      const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
        result: () => Promise<{ openclawCallId?: string }>;
      };
      const result = await stream.result();
      expect(result.openclawCallId).toBe("call-1");
    });

    expect(events.map((event) => event.type)).toEqual([
      "model.call.started",
      "model.call.completed",
    ]);
    expect(events[0]?.callId).toBe("call-1");
    expect(events[1]?.callId).toBe("call-1");
  });

  it("does not attach call identity to non-assistant results", async () => {
    const { wrapped } = wrapSingleCall({
      nextCallId: "call-non-assistant",
      result: { role: "user", content: "not an assistant" },
    });

    const stream = wrapped({} as never, {} as never, {} as never) as unknown as {
      result: () => Promise<Record<string, unknown>>;
    };
    const result = await stream.result();
    expect(result).not.toHaveProperty("openclawCallId");
  });
});
