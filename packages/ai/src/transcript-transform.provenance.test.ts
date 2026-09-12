import { describe, expect, it } from "vitest";
import { transformMessages } from "./transcript-transform.js";
import type { AssistantMessage, Message } from "./types.js";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

const model = {
  id: "deepseek-v4-pro",
  provider: "deepseek",
  api: "openai-completions",
  input: ["text"],
} as never;

describe("transformMessages drops openclawProvenance blocks", () => {
  it("drops a historical provenance block from replay context", () => {
    const messages: Message[] = [
      assistant([
        { type: "text", text: "answer" },
        { type: "openclawProvenance", usedEvidenceIds: ["ev_1"] },
      ]),
    ];
    const transformed = transformMessages(messages, model);
    const assistantMessage = transformed[0] as AssistantMessage;
    expect(assistantMessage.content.some((block) => block.type === "openclawProvenance")).toBe(
      false,
    );
    expect(assistantMessage.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("does not treat a provenance block as a tool call", () => {
    const messages: Message[] = [
      assistant([{ type: "openclawProvenance", usedEvidenceIds: ["ev_1"] }]),
    ];
    const transformed = transformMessages(messages, model);
    const assistantMessage = transformed[0] as AssistantMessage;
    expect(assistantMessage.content.some((block) => block.type === "toolCall")).toBe(false);
    expect(assistantMessage.content).toEqual([]);
  });
});
