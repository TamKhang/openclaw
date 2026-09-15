/**
 * Host-owned, one-shot Bruno High Brain classification authority.
 *
 * "Bruno, high brain:" is an owner-authorized, one-query HIGH
 * classification/tier override. It is not an explicit model override: the
 * canonical Bruno Model Routing policy still resolves the HIGH primary and
 * approved HIGH fallback. High Brain logic never names a provider or model.
 *
 * Trusted WhatsApp channel feature code registers an override here (through
 * the same host-injected, bundled-only registrar mechanism as the send
 * authorization registrar). The core routing bridge claims it exactly once
 * per admitted turn, keyed by the stable inbound event identity. The model
 * has no path to register or claim an override; a missing, malformed,
 * consumed, or expired override fails closed.
 */
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("bruno-high-brain");

export const BRUNO_HIGH_BRAIN_POLICY_VERSION = 1 as const;
export const BRUNO_HIGH_BRAIN_REQUESTED_TIER = "high" as const;
export const BRUNO_HIGH_BRAIN_OVERRIDE_TTL_MS = 120_000;

export type BrunoHighBrainOverride = {
  policyVersion: typeof BRUNO_HIGH_BRAIN_POLICY_VERSION;
  /** Opaque, content-free inbound event identity hash. Never logged. */
  sourceEventId: string;
  mode: "dm" | "group";
  requestedTier: typeof BRUNO_HIGH_BRAIN_REQUESTED_TIER;
  createdAt: number;
  expiresAt: number;
};

export type BrunoHighBrainOverrideRegistration = {
  override: BrunoHighBrainOverride;
  consumed: boolean;
  consumedAt?: number;
};

export type BrunoHighBrainClaimResult =
  | { status: "authorized"; override: BrunoHighBrainOverride }
  | { status: "denied"; reason: "missing_override" | "already_consumed" | "expired" };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidOverride(value: unknown): value is BrunoHighBrainOverride {
  if (!value || typeof value !== "object") {
    return false;
  }
  const override = value as Partial<BrunoHighBrainOverride>;
  return (
    override.policyVersion === BRUNO_HIGH_BRAIN_POLICY_VERSION &&
    isNonEmptyString(override.sourceEventId) &&
    (override.mode === "dm" || override.mode === "group") &&
    override.requestedTier === BRUNO_HIGH_BRAIN_REQUESTED_TIER &&
    isFiniteNumber(override.createdAt) &&
    isFiniteNumber(override.expiresAt) &&
    (override.expiresAt as number) > (override.createdAt as number)
  );
}

const registeredOverrides = new Map<string, BrunoHighBrainOverrideRegistration>();

function sweepExpired(now: number): void {
  for (const [sourceEventId, entry] of registeredOverrides) {
    if (now >= entry.override.expiresAt) {
      registeredOverrides.delete(sourceEventId);
    }
  }
}

/**
 * Trusted host registrar. First registration for a source event wins; a
 * malformed override is ignored so the routing claim fails closed.
 */
export function registerBrunoHighBrainOverride(override: BrunoHighBrainOverride): void {
  if (!isValidOverride(override)) {
    log.warn("bruno_high_brain_register_rejected", {
      reason: "malformed_override",
      requestedTier:
        typeof (override as { requestedTier?: unknown } | null)?.requestedTier === "string"
          ? (override as { requestedTier: string }).requestedTier
          : undefined,
    });
    return;
  }
  const existing = registeredOverrides.get(override.sourceEventId);
  if (existing) {
    // First trusted registration wins; never replace an existing override.
    return;
  }
  registeredOverrides.set(override.sourceEventId, { override, consumed: false });
  sweepExpired(Date.now());
  log.info("bruno_high_brain_registered", {
    mode: override.mode,
    requestedTier: override.requestedTier,
    policyVersion: override.policyVersion,
  });
}

/**
 * Atomic one-shot claim. Returns `authorized` exactly once per registered
 * override; missing, consumed, or expired overrides fail closed.
 */
export function claimBrunoHighBrainOverrideForRouting(
  sourceEventId: string,
  now: number = Date.now(),
): BrunoHighBrainClaimResult {
  const entry = registeredOverrides.get(sourceEventId);
  if (!entry) {
    log.warn("bruno_high_brain_claim_denied", { reason: "missing_override" });
    return { status: "denied", reason: "missing_override" };
  }
  if (entry.consumed) {
    log.warn("bruno_high_brain_claim_denied", { reason: "already_consumed" });
    return { status: "denied", reason: "already_consumed" };
  }
  if (now >= entry.override.expiresAt) {
    registeredOverrides.delete(sourceEventId);
    log.warn("bruno_high_brain_claim_denied", { reason: "expired" });
    return { status: "denied", reason: "expired" };
  }
  entry.consumed = true;
  entry.consumedAt = now;
  log.info("bruno_high_brain_claimed", {
    mode: entry.override.mode,
    requestedTier: entry.override.requestedTier,
    policyVersion: entry.override.policyVersion,
  });
  return { status: "authorized", override: entry.override };
}

export function resetBrunoHighBrainOverrideForTests(): void {
  registeredOverrides.clear();
}
