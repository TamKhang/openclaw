// Accepted-final-call authority across the provider-independent agent loop.
//
// The diagnostic wrapper stamps `openclawCallId` on the AssistantMessage it
// returns. These tests prove the agent loop preserves that exact field through
// finalization transforms and terminal-message selection without re-deriving it
// from position, timing, or model content.
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop, runAgentLoop } from "./agent-loop.js";
import { Agent } from "./agent.js";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Model,
} from "./llm.js";
import type { AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "./types.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

function assistant(
  content: AssistantMessage["content"],
  options: {
    stopReason?: AssistantMessage["stopReason"];
    openclawCallId?: string;
  } = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options.stopReason ?? "stop",
    timestamp: 1,
    ...(options.openclawCallId ? { openclawCallId: options.openclawCallId } : {}),
  };
}

function terminalStream(
  message: AssistantMessage,
): ReturnType<typeof createAssistantMessageEventStream> {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end();
  });
  return stream;
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

async function collectMessages(streamFn: StreamFn): Promise<AgentMessage[]> {
  const stream = agentLoop(
    [{ role: "user", content: "hello", timestamp: 1 }],
    { systemPrompt: "", messages: [] },
    config,
    undefined,
    streamFn,
  );
  return await stream.result();
}

function makeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => ({
      content: [{ type: "text", text: `${name} result` }],
      details: { name },
    }),
  };
}

describe("agent loop accepted-final call authority", () => {
  it("preserves the runtime callId on the accepted terminal assistant message", async () => {
    const messages = await collectMessages((_model, _context) =>
      terminalStream(
        assistant([{ type: "text", text: "final answer" }], {
          openclawCallId: "call_1",
        }),
      ),
    );

    const terminal = lastAssistant(messages);
    expect(terminal).toMatchObject({ stopReason: "stop", openclawCallId: "call_1" });
  });

  it("keeps the terminal tool-cycle callId authoritative over its tool-use predecessor", async () => {
    let calls = 0;
    const streamFn: StreamFn = (_model, _context) => {
      calls += 1;
      if (calls === 1) {
        return terminalStream(
          assistant(
            [
              {
                type: "toolCall",
                id: "call-tool",
                name: "lookup",
                arguments: {},
              },
            ],
            { stopReason: "toolUse", openclawCallId: "call_1" },
          ),
        );
      }
      return terminalStream(
        assistant([{ type: "text", text: "answer after tool" }], {
          openclawCallId: "call_2",
        }),
      );
    };

    const agent = new Agent({
      initialState: { model, tools: [makeTool("lookup")] },
      streamFn,
      convertToLlm: (messages) =>
        messages.filter(
          (message): message is Message =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
        ),
    });
    await agent.prompt("look something up");

    const assistantMessages = agent.state.messages.filter(
      (message) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]).toMatchObject({ stopReason: "toolUse", openclawCallId: "call_1" });
    expect(assistantMessages[1]).toMatchObject({ stopReason: "stop", openclawCallId: "call_2" });
    expect(assistantMessages[0]?.openclawCallId).toBe("call_1");
    expect(assistantMessages[1]?.openclawCallId).toBe("call_2");
    // The accepted terminal message is the second model invocation, never the tool-use predecessor.
    expect(assistantMessages[1]?.openclawCallId).not.toBe("call_1");
  });

  it("does not fabricate a callId for a failed stream with no accepted terminal message", async () => {
    const messages = await collectMessages(async () => {
      throw new Error("provider exploded");
    });

    const terminal = lastAssistant(messages);
    expect(terminal).toMatchObject({ stopReason: "error" });
    expect(terminal?.openclawCallId).toBeUndefined();
  });

  it("preserves the runtime callId through runAgentLoop with no streamed events", async () => {
    const messages = await runAgentLoop(
      [{ role: "user", content: "hello", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      config,
      async () => {},
      undefined,
      (_model, _context) =>
        terminalStream(
          assistant([{ type: "text", text: "direct final" }], {
            openclawCallId: "call_direct",
          }),
        ),
    );
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "stop",
      openclawCallId: "call_direct",
    });
  });
});
