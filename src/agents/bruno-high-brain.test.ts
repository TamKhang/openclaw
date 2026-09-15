// Core one-shot High Brain classification authority: registration is
// first-wins and validated, claims are atomic and exactly-once, and missing,
// malformed, consumed, or expired overrides fail closed without leaking into
// a following or concurrent turn.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRUNO_HIGH_BRAIN_OVERRIDE_TTL_MS,
  claimBrunoHighBrainOverrideForRouting,
  registerBrunoHighBrainOverride,
  resetBrunoHighBrainOverrideForTests,
  type BrunoHighBrainOverride,
} from "./bruno-high-brain.js";

function override(overrides: Partial<BrunoHighBrainOverride> = {}): BrunoHighBrainOverride {
  const now = Date.now();
  return {
    policyVersion: 1,
    sourceEventId: "source-event-1",
    mode: "dm",
    requestedTier: "high",
    createdAt: now,
    expiresAt: now + BRUNO_HIGH_BRAIN_OVERRIDE_TTL_MS,
    ...overrides,
  };
}

afterEach(() => {
  resetBrunoHighBrainOverrideForTests();
});

describe("registerBrunoHighBrainOverride", () => {
  it("registers a valid override and claims it exactly once", () => {
    registerBrunoHighBrainOverride(override());
    const first = claimBrunoHighBrainOverrideForRouting("source-event-1", Date.now() + 1);
    expect(first.status).toBe("authorized");
    if (first.status === "authorized") {
      expect(first.override).toMatchObject({ mode: "dm", requestedTier: "high" });
    }
    expect(claimBrunoHighBrainOverrideForRouting("source-event-1", Date.now() + 2)).toMatchObject({
      status: "denied",
      reason: "already_consumed",
    });
  });

  it("rejects a malformed override so the claim fails closed", () => {
    registerBrunoHighBrainOverride(override({ policyVersion: 2 as 1 }));
    expect(claimBrunoHighBrainOverrideForRouting("source-event-1", Date.now() + 1)).toMatchObject({
      status: "denied",
      reason: "missing_override",
    });
  });

  it("never replaces an existing override for the same source event", () => {
    const first = override({ mode: "dm" });
    registerBrunoHighBrainOverride(first);
    registerBrunoHighBrainOverride(override({ mode: "group" }));
    const claim = claimBrunoHighBrainOverrideForRouting("source-event-1", Date.now() + 1);
    expect(claim.status).toBe("authorized");
    if (claim.status === "authorized") {
      expect(claim.override.mode).toBe("dm");
    }
  });

  it("denies a missing override", () => {
    expect(claimBrunoHighBrainOverrideForRouting("never-registered", Date.now() + 1)).toMatchObject(
      {
        status: "denied",
        reason: "missing_override",
      },
    );
  });

  it("denies an expired override and does not leave it claimable", () => {
    const now = Date.now();
    registerBrunoHighBrainOverride(override({ createdAt: now, expiresAt: now + 60_000 }));
    expect(claimBrunoHighBrainOverrideForRouting("source-event-1", now + 60_001)).toMatchObject({
      status: "denied",
      reason: "expired",
    });
    expect(claimBrunoHighBrainOverrideForRouting("source-event-1", now + 60_002)).toMatchObject({
      status: "denied",
      reason: "missing_override",
    });
  });
});

describe("one-shot isolation", () => {
  it("consumes only the claimed source event, never a sibling event", () => {
    registerBrunoHighBrainOverride(override({ sourceEventId: "event-a" }));
    registerBrunoHighBrainOverride(override({ sourceEventId: "event-b", mode: "group" }));
    expect(claimBrunoHighBrainOverrideForRouting("event-a", Date.now() + 1).status).toBe(
      "authorized",
    );
    const sibling = claimBrunoHighBrainOverrideForRouting("event-b", Date.now() + 2);
    expect(sibling.status).toBe("authorized");
    if (sibling.status === "authorized") {
      expect(sibling.override.mode).toBe("group");
    }
    expect(claimBrunoHighBrainOverrideForRouting("event-a", Date.now() + 3)).toMatchObject({
      status: "denied",
      reason: "already_consumed",
    });
  });

  it("does not expose the registry through a global store", () => {
    const moduleSpace = globalThis as Record<string, unknown>;
    expect(moduleSpace.brunoHighBrainOverrideRegistry).toBeUndefined();
    expect(vi.isMockFunction(registerBrunoHighBrainOverride)).toBe(false);
  });
});
