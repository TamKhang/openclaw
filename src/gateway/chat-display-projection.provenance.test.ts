import { describe, expect, it } from "vitest";
import { sanitizeChatHistoryMessages } from "./chat-display-projection.sanitize.js";

describe("chat history projection strips openclawProvenance blocks", () => {
  it("removes a hidden provenance block while keeping visible text", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "openclawProvenance", usedEvidenceIds: ["ev_1"] },
        ],
      },
    ];
    expect(sanitizeChatHistoryMessages(messages)).toEqual([
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]);
  });

  it("drops a provenance-only assistant message content to empty", () => {
    const messages = [
      { role: "assistant", content: [{ type: "openclawProvenance", usedEvidenceIds: ["ev_1"] }] },
    ];
    const [projected] = sanitizeChatHistoryMessages(messages);
    expect((projected as { content: unknown[] }).content).toEqual([]);
  });
});
