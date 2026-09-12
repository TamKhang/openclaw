import { describe, expect, it } from "vitest";
import {
  createEvidenceSentinelScanner,
  EVIDENCE_SENTINEL_MARKER,
  extractFinalEvidenceProjection,
  isCanonicalEvidenceId,
  MAX_EVIDENCE_PROJECTION_CODE_UNITS,
} from "./answer-evidence.js";

function chunkAll(text: string, sizes: number[]): string[] {
  const chunks: string[] = [];
  let index = 0;
  for (const size of sizes) {
    if (index >= text.length) break;
    chunks.push(text.slice(index, index + size));
    index += size;
  }
  if (index < text.length) chunks.push(text.slice(index));
  return chunks;
}

function runScanner(
  input: string,
  chunkSizes: number[],
): { visible: string; usedEvidenceIds?: string[] } {
  const scanner = createEvidenceSentinelScanner();
  let visible = "";
  for (const chunk of chunkAll(input, chunkSizes)) {
    visible += scanner.push(chunk);
  }
  const fin = scanner.finalize();
  return { visible: visible + fin.visible, usedEvidenceIds: fin.usedEvidenceIds };
}

const VALID = `${EVIDENCE_SENTINEL_MARKER}["ev_1"]`;

describe("isCanonicalEvidenceId", () => {
  it("accepts opaque tokens", () => {
    expect(isCanonicalEvidenceId("ev_1")).toBe(true);
    expect(isCanonicalEvidenceId("a.b-c~d_e")).toBe(true);
  });
  it("rejects non-canonical IDs", () => {
    expect(isCanonicalEvidenceId("not valid id!")).toBe(false);
    expect(isCanonicalEvidenceId("")).toBe(false);
    expect(isCanonicalEvidenceId('with"quote')).toBe(false);
    expect(isCanonicalEvidenceId(" spaced")).toBe(false);
  });
});

describe("evidence sentinel scanner (streaming suppression)", () => {
  it("accepts a whole sentinel", () => {
    const result = runScanner(`answer\n${VALID}`, [1000]);
    expect(result.visible).toBe("answer\n");
    expect(result.usedEvidenceIds).toEqual(["ev_1"]);
  });

  it("withholds a sentinel split across chunks", () => {
    const input = `answer\n${VALID}`;
    const result = runScanner(input, [
      "answer\nOPEN".length,
      "CLAW_EVIDENCE:".length,
      '["ev_1"]'.length,
    ]);
    expect(result.visible).toBe("answer\n");
    expect(result.usedEvidenceIds).toEqual(["ev_1"]);
  });

  it("withholds character-by-character", () => {
    const input = `answer\n${VALID}`;
    const result = runScanner(input, Array(input.length).fill(1));
    expect(result.visible).toBe("answer\n");
    expect(result.usedEvidenceIds).toEqual(["ev_1"]);
  });

  it("releases a false marker prefix as ordinary text", () => {
    const input = `answer\n${EVIDENCE_SENTINEL_MARKER} not evidence\nnext`;
    const result = runScanner(input, [1000]);
    expect(result.visible).toBe(input);
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("releases a marker without colon as ordinary text", () => {
    const input = `answer\nOPENCLAW_EVIDENCE then text`;
    const result = runScanner(input, [1000]);
    expect(result.visible).toBe(input);
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("fails closed on a malformed terminal sentinel", () => {
    const result = runScanner(`answer\n${EVIDENCE_SENTINEL_MARKER}["ev_1"`, [1000]);
    expect(result.visible).toBe("answer\n");
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("rejects a valid sentinel followed by extra visible text", () => {
    const result = runScanner(`answer\n${VALID}\nmore text`, [1000]);
    expect(result.visible).toBe("answer\n\nmore text");
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("fails closed on multiple sentinels", () => {
    const input = `answer\n${EVIDENCE_SENTINEL_MARKER}["a"]\n${EVIDENCE_SENTINEL_MARKER}["b"]`;
    const result = runScanner(input, [1000]);
    expect(result.visible).toBe("answer\n\n");
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("produces no projection for an empty array", () => {
    const result = runScanner(`answer\n${EVIDENCE_SENTINEL_MARKER}[]`, [1000]);
    expect(result.visible).toBe("answer\n");
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("handles arbitrary chunking around JSON quotes/brackets", () => {
    const input = `answer\n${EVIDENCE_SENTINEL_MARKER}["ev_1","ev_2"]`;
    const result = runScanner(input, [2, 1, 3, 1, 2, 4, 1, 5, 2, 3, 1, 1, 1, 2, 3, 1, 2]);
    expect(result.visible).toBe("answer\n");
    expect(result.usedEvidenceIds).toEqual(["ev_1", "ev_2"]);
  });

  it("rejects an escaped-quote ID as non-canonical", () => {
    const input = `answer\n${EVIDENCE_SENTINEL_MARKER}["ev_\\"1","ev_2"]`;
    const result = runScanner(input, [2, 1, 3, 1, 2, 4, 1, 5, 2, 3, 1, 1, 1, 2, 3, 1, 2]);
    expect(result.visible).toBe("answer\n");
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("keeps non-sentinel bytes byte-for-byte", () => {
    const input = `The answer.\n\nDetails here.\n${EVIDENCE_SENTINEL_MARKER}["ev_a","ev_b"]`;
    const result = runScanner(input, [1, 2, 3, 1, 1, 2]);
    expect(result.visible).toBe("The answer.\n\nDetails here.\n");
    expect(result.usedEvidenceIds).toEqual(["ev_a", "ev_b"]);
  });

  it("accepts LF + EOF and CRLF + EOF terminators", () => {
    expect(runScanner(`answer\n${VALID}\n`, [1000])).toEqual({
      visible: "answer\n\n",
      usedEvidenceIds: ["ev_1"],
    });
    expect(runScanner(`answer\n${VALID}\r\n`, [1000])).toEqual({
      visible: "answer\n\r\n",
      usedEvidenceIds: ["ev_1"],
    });
  });

  it("rejects CRLF followed by visible text", () => {
    const result = runScanner(`answer\n${VALID}\r\nvisible text`, [1000]);
    expect(result.visible).toBe("answer\n\r\nvisible text");
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("rejects bare CR termination", () => {
    const result = runScanner(`answer\n${VALID}\r`, [1000]);
    expect(result.visible).toBe("answer\n\r");
    expect(result.usedEvidenceIds).toBeUndefined();
  });
});

describe("line-start grammar", () => {
  it("accepts a marker at the beginning of output", () => {
    const result = runScanner(VALID, [1000]);
    expect(result.visible).toBe("");
    expect(result.usedEvidenceIds).toEqual(["ev_1"]);
  });

  it("accepts a marker immediately after LF", () => {
    const result = runScanner(`text\n${VALID}`, [1000]);
    expect(result.visible).toBe("text\n");
    expect(result.usedEvidenceIds).toEqual(["ev_1"]);
  });

  it("treats a mid-line marker as ordinary text", () => {
    const input = `text ${VALID}`;
    const result = runScanner(input, [1000]);
    expect(result.visible).toBe(input);
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("treats a mid-line overlap as ordinary text", () => {
    const input = `O${VALID}`;
    const result = runScanner(input, [1000]);
    expect(result.visible).toBe(input);
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("handles overlap at a line boundary", () => {
    const result = runScanner(`O\n${VALID}`, [1000]);
    expect(result.visible).toBe("O\n");
    expect(result.usedEvidenceIds).toEqual(["ev_1"]);
  });

  it("accepts a marker after CRLF", () => {
    const result = runScanner(`text\r\n${VALID}`, [1000]);
    expect(result.visible).toBe("text\r\n");
    expect(result.usedEvidenceIds).toEqual(["ev_1"]);
  });
});

describe("overflow bounds", () => {
  const bigPayload = "x".repeat(MAX_EVIDENCE_PROJECTION_CODE_UNITS + 1000);

  it("fails closed on overflow + LF", () => {
    const result = runScanner(`answer\n${EVIDENCE_SENTINEL_MARKER}[${bigPayload}]\n`, [1000]);
    expect(result.visible).toBe("answer\n");
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("fails closed on overflow + EOF", () => {
    const result = runScanner(`answer\n${EVIDENCE_SENTINEL_MARKER}[${bigPayload}]`, [1000]);
    expect(result.visible).toBe("answer\n");
    expect(result.usedEvidenceIds).toBeUndefined();
  });

  it("keeps retained state bounded on a 1,000,000-code-unit malformed projection", () => {
    const scanner = createEvidenceSentinelScanner();
    let visible = scanner.push(`answer\n${EVIDENCE_SENTINEL_MARKER}[`);
    let maxSeen = scanner.stateSize();
    for (let index = 0; index < 1_000_000; index += 997) {
      visible += scanner.push("a".repeat(Math.min(997, 1_000_000 - index)));
      maxSeen = Math.max(maxSeen, scanner.stateSize());
    }
    const fin = scanner.finalize();
    visible += fin.visible;
    expect(visible).toBe("answer\n");
    expect(fin.usedEvidenceIds).toBeUndefined();
    expect(maxSeen).toBeLessThanOrEqual(2 * MAX_EVIDENCE_PROJECTION_CODE_UNITS + 18 + 4);
  });
});

describe("extractFinalEvidenceProjection", () => {
  it("strips a valid final sentinel", () => {
    expect(extractFinalEvidenceProjection(`answer\n${VALID}`)).toEqual({
      visibleText: "answer\n",
      usedEvidenceIds: ["ev_1"],
    });
  });

  it("strips the sentinel line but returns no projection when malformed", () => {
    expect(extractFinalEvidenceProjection(`answer\n${EVIDENCE_SENTINEL_MARKER}["bad`)).toEqual({
      visibleText: "answer\n",
      usedEvidenceIds: undefined,
    });
  });

  it("leaves mid-line marker text untouched", () => {
    expect(extractFinalEvidenceProjection(`text ${VALID}`)).toEqual({
      visibleText: `text ${VALID}`,
      usedEvidenceIds: undefined,
    });
  });

  it("rejects non-canonical IDs", () => {
    expect(
      extractFinalEvidenceProjection(`answer\n${EVIDENCE_SENTINEL_MARKER}["not canonical!"]`),
    ).toEqual({ visibleText: "answer\n", usedEvidenceIds: undefined });
  });
});
