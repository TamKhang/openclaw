import { describe, expect, it } from "vitest";
import { resolveModelCandidateChain } from "../../agents/model-fallback-candidates.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveModelFallbackOptions } from "./agent-runner-run-params.js";
import type { FollowupRun } from "./queue.js";

function legacyConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "openrouter/openrouter/free",
          fallbacks: ["openrouter/openrouter/free"],
        },
      },
    },
  } as OpenClawConfig;
}

function runWithBrunoFallbacks(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun["run"] {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    sessionId: "session-1",
    sessionFile: "/tmp/session.json",
    workspaceDir: "/tmp/workspace",
    config: legacyConfig(),
    provider: "deepseek",
    model: "deepseek-v4-flash",
    ...overrides,
  } as FollowupRun["run"];
}

describe("Bruno fallback authority", () => {
  it("uses Bruno-approved fallbacks instead of legacy configured fallbacks", () => {
    const run = runWithBrunoFallbacks({
      brunoApprovedFallbacks: ["google/gemini-3.8-flash"],
    });
    expect(resolveModelFallbackOptions(run).fallbacksOverride).toEqual(["google/gemini-3.8-flash"]);
  });

  it("falls back to legacy configured fallbacks outside Bruno scope", () => {
    const run = runWithBrunoFallbacks();
    expect(resolveModelFallbackOptions(run).fallbacksOverride).not.toEqual([
      "google/gemini-3.8-flash",
    ]);
  });

  it("empty Bruno fallback list fails closed instead of restoring legacy fallbacks", () => {
    const run = runWithBrunoFallbacks({ brunoApprovedFallbacks: [] });
    expect(resolveModelFallbackOptions(run).fallbacksOverride).toEqual([]);
    const candidates = resolveModelCandidateChain({
      cfg: legacyConfig(),
      agentId: "main",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      fallbacksOverride: [],
    });
    expect(candidates.map((candidate) => `${candidate.provider}/${candidate.model}`)).toEqual([
      "deepseek/deepseek-v4-flash",
    ]);
  });

  it("resolves only the Bruno-approved candidates plus the Bruno primary", () => {
    const candidates = resolveModelCandidateChain({
      cfg: legacyConfig(),
      agentId: "main",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      fallbacksOverride: ["google/gemini-3.8-flash"],
    });
    const refs = candidates.map((candidate) => `${candidate.provider}/${candidate.model}`);
    expect(refs).toEqual(["deepseek/deepseek-v4-flash", "google/gemini-3.8-flash"]);
    expect(refs.some((ref) => ref.includes("openrouter/free"))).toBe(false);
  });

  it("rejects an OpenClaw-configured fallback that Bruno did not admit", () => {
    const candidates = resolveModelCandidateChain({
      cfg: legacyConfig(),
      agentId: "main",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      fallbacksOverride: ["google/gemini-3.8-flash"],
    });
    expect(candidates.some((candidate) => candidate.model === "openrouter/free")).toBe(false);
  });
});
