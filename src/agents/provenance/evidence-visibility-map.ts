/**
 * Trusted per-execution evidence visibility map + fail-closed validation.
 *
 * Key: {runId, callId} -> evidenceId -> trusted source metadata.
 *
 * The model may output ONLY opaque evidence IDs. Source metadata (Mail,
 * OneDrive, Dropbox, Memory, Web, provider, filename, path, query, content,
 * etc.) is resolved exclusively runtime-side and registered here by the
 * owning evidence producer. The Knowledge Flow gate will populate this map;
 * Gate 2D supplies the substrate and the validation contract.
 */

import type { AssistantMessage } from "../../llm/types.js";
import { isCanonicalEvidenceId } from "./answer-evidence.js";

export interface TrustedEvidenceSourceMetadata {
  /** Runtime-owned source kind, e.g. "mail", "onedrive", "dropbox". Never model-supplied. */
  sourceKind: string;
}

export interface EvidenceVisibilityMap {
  register(
    runId: string,
    callId: string,
    evidenceId: string,
    source: TrustedEvidenceSourceMetadata,
  ): void;
  has(runId: string, callId: string, evidenceId: string): boolean;
  get(runId: string, callId: string, evidenceId: string): TrustedEvidenceSourceMetadata | undefined;
  clear(): void;
}

/** In-memory substrate for tests and single-process use. */
export function createEvidenceVisibilityMap(): EvidenceVisibilityMap {
  const rows = new Map<string, Map<string, TrustedEvidenceSourceMetadata>>();

  function keyFor(runId: string, callId: string): string {
    return `${runId}\u0000${callId}`;
  }

  return {
    register(runId, callId, evidenceId, source) {
      if (!isCanonicalEvidenceId(evidenceId)) {
        return; // non-canonical IDs are never registered
      }
      const key = keyFor(runId, callId);
      let byId = rows.get(key);
      if (!byId) {
        byId = new Map();
        rows.set(key, byId);
      }
      byId.set(evidenceId, source);
    },
    has(runId, callId, evidenceId) {
      return rows.get(keyFor(runId, callId))?.has(evidenceId) === true;
    },
    get(runId, callId, evidenceId) {
      return rows.get(keyFor(runId, callId))?.get(evidenceId);
    },
    clear() {
      rows.clear();
    },
  };
}

export interface ResolveAcceptedEvidenceParams {
  /** The run that produced the accepted terminal answer. */
  runId: string;
  /** Gate 2B runtime-owned accepted final call authority. */
  acceptedFinalCallId: string;
  /** The exact accepted terminal AssistantMessage (from the current run). */
  assistant: AssistantMessage | undefined;
  visibilityMap: EvidenceVisibilityMap;
}

/**
 * Fail-closed resolution of the model-declared used evidence IDs for the
 * accepted final call.
 *
 * The only authoritative pairing is:
 *   final runId + acceptedFinalCallId + the projection carried by that exact
 *   accepted AssistantMessage + the visibility map for that exact {runId,callId}.
 *
 * Any missing/empty/malformed/unknown/stale/cross-run/cross-call/non-canonical
 * projection invalidates the ENTIRE knowledge projection.
 */
export function resolveAcceptedUsedEvidenceIds(
  params: ResolveAcceptedEvidenceParams,
): string[] | undefined {
  const { runId, acceptedFinalCallId, assistant, visibilityMap } = params;
  if (!assistant || assistant.role !== "assistant") {
    return undefined;
  }
  if (typeof assistant.openclawCallId !== "string") {
    return undefined;
  }
  if (assistant.openclawCallId !== acceptedFinalCallId) {
    return undefined;
  }
  if (!Array.isArray(assistant.content)) {
    return undefined;
  }
  const block = assistant.content.find(
    (entry): entry is Extract<(typeof assistant.content)[number], { type: "openclawProvenance" }> =>
      entry.type === "openclawProvenance",
  );
  if (!block) {
    return undefined;
  }
  const ids = block.usedEvidenceIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return undefined;
  }
  const deduped = [...new Set(ids)];
  for (const id of deduped) {
    if (!isCanonicalEvidenceId(id)) {
      return undefined; // ANY non-canonical ID invalidates the entire projection
    }
    if (!visibilityMap.has(runId, acceptedFinalCallId, id)) {
      return undefined; // ANY unknown/stale/cross-run/cross-call ID invalidates all
    }
  }
  return deduped;
}
