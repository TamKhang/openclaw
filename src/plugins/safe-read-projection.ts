// Defines the narrow metadata contract that a plugin-owned tool uses to opt
// into the fixed read-projection boundary. This file intentionally only owns
// the declaration shape and validation; the gateway owns enforcement and the
// plugin owns the actual tool behavior.

export const SAFE_READ_PROJECTION_CAPABILITIES = ["status-read"] as const;

export type SafeReadProjectionCapability = (typeof SAFE_READ_PROJECTION_CAPABILITIES)[number];

/** Plugin-authored safe-read declaration for one tool. */
export type PluginSafeReadProjection = {
  capabilities: readonly SafeReadProjectionCapability[];
};

export type NormalizedPluginSafeReadProjection = {
  capabilities: SafeReadProjectionCapability[];
};

const CAPABILITY_SET: ReadonlySet<string> = new Set<string>(SAFE_READ_PROJECTION_CAPABILITIES);

/**
 * Validates a plugin-safe-read declaration without accepting unknown capability
 * families. A retrieval/message/shell/provider capability is therefore not a
 * valid opt-in; it cannot merely be ignored.
 */
export function normalizeSafeReadProjection(
  value: unknown,
): { ok: true; value: NormalizedPluginSafeReadProjection } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "safe-read projection must be an object" };
  }
  // SAFETY: value is a non-null, non-array object (guarded above); capabilities is read and validated below.
  const record = value as Record<string, unknown>;
  const rawCapabilities = record.capabilities;
  if (!Array.isArray(rawCapabilities) || rawCapabilities.length === 0) {
    return { ok: false, error: "safe-read projection requires capabilities" };
  }
  const capabilities: SafeReadProjectionCapability[] = [];
  const seen = new Set<string>();
  for (const capability of rawCapabilities) {
    if (typeof capability !== "string" || !CAPABILITY_SET.has(capability)) {
      return { ok: false, error: "safe-read projection contains an unsupported capability" };
    }
    if (seen.has(capability)) {
      return { ok: false, error: "safe-read projection contains duplicate capabilities" };
    }
    seen.add(capability);
    // SAFETY: capability is a string verified present in CAPABILITY_SET, which is derived from SAFE_READ_PROJECTION_CAPABILITIES.
    capabilities.push(capability as SafeReadProjectionCapability);
  }
  return { ok: true, value: { capabilities } };
}
