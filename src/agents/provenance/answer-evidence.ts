/**
 * Answer-time evidence projection substrate.
 *
 * Certified contract (Gate 2C.3):
 *
 *   line       := MARKER JSON_ARRAY ( EOF | LF EOF | CRLF EOF )
 *   MARKER     := "OPENCLAW_EVIDENCE:"
 *   JSON_ARRAY := '[' non-empty JSON array of strings ']'
 *
 * - MARKER is recognized only at a line start: beginning of output, or
 *   immediately after LF (including the LF of a CRLF).
 * - Mid-line MARKER occurrences are ordinary visible text, never syntax.
 * - The sentinel line must be terminal: nothing but EOF / LF / CRLF may follow
 *   the closing ']'. Bare CR is not a valid terminal ending.
 * - Multiple sentinels, empty arrays, malformed JSON, non-canonical IDs, and
 *   overflow all fail closed (no projection; the control line stays hidden).
 *
 * The model may declare opaque evidence IDs only. Source metadata is resolved
 * exclusively by the runtime visibility map, never from this channel.
 *
 * This is validated structured self-declaration, not proof of hidden cognition.
 */

export const EVIDENCE_SENTINEL_MARKER = "OPENCLAW_EVIDENCE:";

/** Hard cap on a projection line, in UTF-16 code units (JS string length). */
export const MAX_EVIDENCE_PROJECTION_CODE_UNITS = 4096;

const CANONICAL_EVIDENCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

/** Canonical opaque evidence-ID syntax. Source labels must never be admitted here. */
export function isCanonicalEvidenceId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_EVIDENCE_ID_RE.test(value);
}

export interface EvidenceSentinelScanner {
  /**
   * Feed one chunk of streamed text. Returns the text that is proven safe to
   * release to a user-facing surface. Sentinel control bytes are withheld
   * until they are classified; false prefixes are released as ordinary text.
   */
  push(chunk: string, options?: { final?: boolean }): string;
  /** Flush end-of-stream state and report the projection (if exactly one valid terminal sentinel). */
  finalize(): { visible: string; usedEvidenceIds?: string[] };
  /** Retained code-unit count (debug/assertion surface). */
  stateSize(): number;
}

/**
 * Stateful, bounded, line-start-aware scanner for the answer-evidence sentinel.
 * One instance per message; the SAME grammar powers live streaming suppression
 * and final-result extraction so the two can never disagree.
 */
export function createEvidenceSentinelScanner(
  marker: string = EVIDENCE_SENTINEL_MARKER,
  maxProjectionCodeUnits: number = MAX_EVIDENCE_PROJECTION_CODE_UNITS,
): EvidenceSentinelScanner {
  let mode = "normal"; // normal | marker_seen | in_projection | post_close
  let pending = ""; // withheld line-start marker candidate (<= marker.length)
  let atLineStart = true;
  let proj = ""; // JSON text inside [ ... ]
  let captured = ""; // marker + '[' + proj (overflow accounting)
  let overflowed = false;
  let depth = 0;
  let inString = false;
  let escape = false;
  let termState = "none"; // post_close: none | cr | lf
  let projectionCount = 0;
  let ids: string[] | undefined;
  let lastFinal = false;

  function recordInvalid(): void {
    ids = undefined;
    lastFinal = false;
  }

  function parseClosed(): void {
    try {
      const parsed = JSON.parse(proj) as unknown;
      ids =
        Array.isArray(parsed) && parsed.length > 0 && parsed.every(isCanonicalEvidenceId)
          ? (parsed as string[])
          : undefined;
    } catch {
      ids = undefined;
    }
  }

  function processNormal(c: string): string {
    let out = "";
    if (pending === "" && atLineStart && c === marker[0]) {
      pending = c;
      atLineStart = false;
      return out;
    }
    if (pending !== "") {
      pending += c;
      if (pending === marker) {
        pending = "";
        mode = "marker_seen";
        atLineStart = false;
        return out;
      }
      if (marker.startsWith(pending)) {
        return out; // strict prefix: withhold
      }
      // Mismatch: flush the whole candidate. The marker is newline-free and the
      // candidate began at line start, so no flushed suffix can begin a marker.
      out += pending;
      atLineStart = pending.endsWith("\n");
      pending = "";
      return out;
    }
    out += c;
    atLineStart = c === "\n";
    return out;
  }

  function push(chunk: string, options?: { final?: boolean }): string {
    let out = "";
    for (const c of chunk) {
      if (mode === "normal") {
        out += processNormal(c);
      } else if (mode === "marker_seen") {
        if (c === "[") {
          mode = "in_projection";
          proj = "[";
          captured = marker + "[";
          depth = 1;
          inString = false;
          escape = false;
          overflowed = false;
          projectionCount += 1;
        } else {
          out += marker; // false marker: release as ordinary text
          mode = "normal";
          pending = "";
          atLineStart = false;
          out += processNormal(c);
        }
      } else if (mode === "in_projection") {
        if (overflowed) {
          // Suppressed overflow line: drop bytes without retaining them.
          if (c === "\n" || c === "\r") {
            mode = "normal";
            recordInvalid();
            atLineStart = c === "\n";
          }
          continue;
        }
        captured += c;
        if (captured.length > maxProjectionCodeUnits + marker.length + 1) {
          overflowed = true;
          proj = "";
          captured = "";
          recordInvalid();
          continue;
        }
        proj += c;
        if (inString) {
          if (escape) escape = false;
          else if (c === "\\") escape = true;
          else if (c === '"') inString = false;
        } else if (c === '"') {
          inString = true;
        } else if (c === "[") {
          depth += 1;
        } else if (c === "]") {
          depth -= 1;
          if (depth === 0) {
            mode = "post_close";
            termState = "none";
            parseClosed();
          }
        }
      } else if (mode === "post_close") {
        if (termState === "none") {
          if (c === "\n") {
            out += c;
            termState = "lf";
            atLineStart = true;
          } else if (c === "\r") {
            out += c;
            termState = "cr";
            atLineStart = false;
          } else {
            recordInvalid();
            mode = "normal";
            pending = "";
            atLineStart = false;
            out += processNormal(c);
          }
        } else if (termState === "cr") {
          if (c === "\n") {
            out += c;
            termState = "lf";
            atLineStart = true;
          } else {
            recordInvalid();
            mode = "normal";
            pending = "";
            atLineStart = false;
            out += processNormal(c);
          }
        } else {
          // termState === "lf": we are at a line start.
          recordInvalid();
          mode = "normal";
          pending = "";
          out += processNormal(c);
        }
      }
    }
    if (options?.final === true) {
      if (mode === "normal") {
        out += pending;
        pending = "";
      } else if (mode === "marker_seen") {
        out += marker;
        mode = "normal";
      } else if (mode === "in_projection") {
        recordInvalid();
        mode = "normal";
      } else if (mode === "post_close") {
        lastFinal = ids !== undefined && (termState === "none" || termState === "lf");
        mode = "normal"; // bare CR at EOF (termState "cr") is invalid
      }
    }
    return out;
  }

  function finalize(): { visible: string; usedEvidenceIds?: string[] } {
    const visible = push("", { final: true });
    const valid = projectionCount === 1 && lastFinal && Array.isArray(ids);
    return { visible, usedEvidenceIds: valid ? ids : undefined };
  }

  function stateSize(): number {
    return pending.length + proj.length + captured.length;
  }

  return { push, finalize, stateSize };
}

export interface EvidenceProjectionExtraction {
  /** Text with the sentinel control line removed (marker + JSON array). */
  visibleText: string;
  /** Present only when exactly one valid terminal sentinel was recognized. */
  usedEvidenceIds?: string[];
}

/** Final-result extraction: run the same certified scanner over the complete text. */
export function extractFinalEvidenceProjection(text: string): EvidenceProjectionExtraction {
  const scanner = createEvidenceSentinelScanner();
  const visible = scanner.push(text);
  const fin = scanner.finalize();
  return { visibleText: visible + fin.visible, usedEvidenceIds: fin.usedEvidenceIds };
}
