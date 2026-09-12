import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import type { EmbeddedAgentSubscribeState } from "./embedded-agent-subscribe.handlers.types.js";
import { createStreamRendering } from "./embedded-agent-subscribe.stream-rendering.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import { createEvidenceSentinelScanner } from "./provenance/answer-evidence.js";

function minimalState(): EmbeddedAgentSubscribeState {
  return {
    suppressBlockChunks: false,
    blockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    partialBlockState: { thinking: false, final: false, inlineCode: createInlineCodeState() },
    blockBuffer: "",
    lastBlockReplyText: undefined,
    lastDeliveredBlockReplyText: undefined,
    toolExecutionSinceLastBlockReply: false,
    blockReplyBreak: "text_end",
    messagingToolSentTextsNormalized: [],
    assistantMessageIndex: 0,
    reasoningStreamOpen: false,
    partialEvidenceScanner: createEvidenceSentinelScanner(),
  } as unknown as EmbeddedAgentSubscribeState;
}

describe("block-reply path answer-evidence suppression", () => {
  it("suppresses a sentinel split across emitBlockChunk calls", () => {
    const pushAssistantText = vi.fn();
    const rendering = createStreamRendering({
      params: {
        onBlockReply: undefined,
        sourceReplyDeliveryMode: "automatic",
        silentExpected: false,
      } as unknown as SubscribeEmbeddedAgentSessionParams,
      state: minimalState(),
      log: { debug: vi.fn() },
      blockChunker: null,
      emitBlockReply: vi.fn(),
      pendingBlockReplyTasks: new Set(),
      pushAssistantText,
      shouldSkipAssistantText: vi.fn(() => false),
    });

    rendering.emitBlockChunk("answer\nOPEN", {});
    rendering.emitBlockChunk('CLAW_EVIDENCE:["ev_1"]', {});
    rendering.emitBlockChunk("", { final: true });

    const sent = pushAssistantText.mock.calls.map(([text]) => String(text)).join("");
    expect(sent).not.toContain("OPENCLAW_EVIDENCE");
    expect(sent).not.toContain("ev_1");
    expect(sent).toContain("answer");
  });

  it("keeps a mid-line marker visible on the block-reply path", () => {
    const pushAssistantText = vi.fn();
    const rendering = createStreamRendering({
      params: {
        onBlockReply: undefined,
        sourceReplyDeliveryMode: "automatic",
        silentExpected: false,
      } as unknown as SubscribeEmbeddedAgentSessionParams,
      state: minimalState(),
      log: { debug: vi.fn() },
      blockChunker: null,
      emitBlockReply: vi.fn(),
      pendingBlockReplyTasks: new Set(),
      pushAssistantText,
      shouldSkipAssistantText: vi.fn(() => false),
    });

    rendering.emitBlockChunk('text OPENCLAW_EVIDENCE:["ev_1"]', { final: true });
    const sent = pushAssistantText.mock.calls.map(([text]) => String(text)).join("");
    expect(sent).toContain("OPENCLAW_EVIDENCE");
    expect(sent).toContain("ev_1");
  });
});
