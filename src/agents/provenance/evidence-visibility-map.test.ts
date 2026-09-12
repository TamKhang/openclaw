import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../../llm/types.js";
import {
  createEvidenceVisibilityMap,
  resolveAcceptedUsedEvidenceIds,
} from "./evidence-visibility-map.js";

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
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
    ...overrides,
  };
}

function withProjection(ids: string[]): AssistantMessage {
  return assistant({
    openclawCallId: "call_1",
    content: [
      { type: "text", text: "answer" },
      { type: "openclawProvenance", usedEvidenceIds: ids },
    ],
  });
}

describe("resolveAcceptedUsedEvidenceIds", () => {
  const map = createEvidenceVisibilityMap();
  map.register("run_1", "call_1", "ev_a", { sourceKind: "mail" });
  map.register("run_1", "call_1", "ev_b", { sourceKind: "onedrive" });

  it("accepts one known ID", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_1",
        assistant: withProjection(["ev_a"]),
        visibilityMap: map,
      }),
    ).toEqual(["ev_a"]);
  });

  it("accepts multiple known IDs and dedupes duplicates", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_1",
        assistant: withProjection(["ev_a", "ev_b", "ev_a"]),
        visibilityMap: map,
      }),
    ).toEqual(["ev_a", "ev_b"]);
  });

  it("returns none for a missing projection", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_1",
        assistant: assistant({ openclawCallId: "call_1" }),
        visibilityMap: map,
      }),
    ).toBeUndefined();
  });

  it("returns none for an empty projection", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_1",
        assistant: withProjection([]),
        visibilityMap: map,
      }),
    ).toBeUndefined();
  });

  it("invalidates the entire projection on an unknown ID", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_1",
        assistant: withProjection(["ev_a", "unknown_id"]),
        visibilityMap: map,
      }),
    ).toBeUndefined();
  });

  it("invalidates on a stale run", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "other_run",
        acceptedFinalCallId: "call_1",
        assistant: withProjection(["ev_a"]),
        visibilityMap: map,
      }),
    ).toBeUndefined();
  });

  it("invalidates on a stale call", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "other_call",
        assistant: withProjection(["ev_a"]),
        visibilityMap: map,
      }),
    ).toBeUndefined();
  });

  it("invalidates on a non-canonical ID", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_1",
        assistant: withProjection(["not canonical!"]),
        visibilityMap: map,
      }),
    ).toBeUndefined();
  });

  it("rejects source-label strings as unknown IDs", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_1",
        assistant: withProjection(["OneDrive"]),
        visibilityMap: map,
      }),
    ).toBeUndefined();
  });

  it("is tuple-scoped: the same evidence ID cannot cross {runId, callId} boundaries", () => {
    const map = createEvidenceVisibilityMap();
    map.register("run_1", "call_1", "shared_id", { sourceKind: "mail" });
    map.register("run_2", "call_2", "shared_id", { sourceKind: "dropbox" });

    expect(map.has("run_1", "call_1", "shared_id")).toBe(true);
    expect(map.has("run_2", "call_2", "shared_id")).toBe(true);
    expect(map.has("run_1", "call_2", "shared_id")).toBe(false);
    expect(map.has("run_2", "call_1", "shared_id")).toBe(false);
    expect(map.get("run_1", "call_2", "shared_id")).toBeUndefined();

    // Validator must not accept a cross-boundary ID.
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_2",
        assistant: withProjection(["shared_id"]),
        visibilityMap: map,
      }),
    ).toBeUndefined();
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_1",
        assistant: withProjection(["shared_id"]),
        visibilityMap: map,
      }),
    ).toEqual(["shared_id"]);
  });

  it("rejects a projection whose message callId does not match acceptedFinalCallId", () => {
    expect(
      resolveAcceptedUsedEvidenceIds({
        runId: "run_1",
        acceptedFinalCallId: "call_2",
        assistant: withProjection(["ev_a"]),
        visibilityMap: map,
      }),
    ).toBeUndefined();
  });
});
