import { describe, expect, it, vi } from "vitest";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";

function completionsTextEvent(delta: string, cumulative: string) {
  return {
    message: { role: "assistant", content: [] },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta,
      partial: {
        role: "assistant",
        content: [{ type: "text", text: cumulative }],
        stopReason: "stop",
        api: "openai-completions",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        usage: {},
        timestamp: 0,
      },
    },
  };
}

describe("handleMessageUpdate answer-evidence streaming suppression", () => {
  it("never exposes a split sentinel through live assistant stream data", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });

    const chunks = ["answer\nOPEN", "CLAW_EVIDENCE:", '["ev_1"]'];
    let cumulative = "";
    for (const delta of chunks) {
      cumulative += delta;
      updateMessage(context, completionsTextEvent(delta, cumulative) as never);
    }

    const texts = onAgentEvent.mock.calls
      .filter(([event]) => event?.stream === "assistant")
      .map(([event]) => String((event.data as { text?: string }).text ?? ""))
      .join("");
    expect(texts).not.toContain("OPENCLAW_EVIDENCE");
    expect(texts).not.toContain("ev_1");
    expect(texts).toContain("answer");
  });

  it("keeps a mid-line marker visible", () => {
    const onAgentEvent = vi.fn();
    const context = createMessageUpdateContext({ onAgentEvent });
    const delta = 'text OPENCLAW_EVIDENCE:["ev_1"]';
    updateMessage(context, completionsTextEvent(delta, delta) as never);

    const texts = onAgentEvent.mock.calls
      .filter(([event]) => event?.stream === "assistant")
      .map(([event]) => String((event.data as { text?: string }).text ?? ""))
      .join("");
    expect(texts).toContain("OPENCLAW_EVIDENCE");
    expect(texts).toContain("ev_1");
  });
});
