// Negative matrix for the High Brain classification registrar resolver. The
// registrar resolves only for the exact canonical WhatsApp pair and never for
// a mismatched plugin id or capability, so another plugin (or another
// capability) cannot mint a HIGH classification override.
import { afterEach, describe, expect, it } from "vitest";
import {
  claimBrunoHighBrainOverrideForRouting,
  registerBrunoHighBrainOverride,
  resetBrunoHighBrainOverrideForTests,
} from "../../agents/bruno-high-brain.js";
import { resolveBundledChannelRuntimeDependency } from "./bundled-runtime-dependencies.js";

afterEach(() => {
  resetBrunoHighBrainOverrideForTests();
});

describe("resolveBundledChannelRuntimeDependency (High Brain registrar)", () => {
  it("resolves the exact core singleton only for the exact canonical whatsapp pair", () => {
    expect(
      resolveBundledChannelRuntimeDependency({
        pluginId: "whatsapp",
        capability: "whatsapp:high-brain-classification-registration",
      }),
    ).toBe(registerBrunoHighBrainOverride);
  });

  it("returns undefined for every non-canonical or mismatched pair", () => {
    const negatives = [
      { pluginId: "discord", capability: "discord:high-brain-classification-registration" },
      { pluginId: "slack", capability: "slack:high-brain-classification-registration" },
      { pluginId: "discord", capability: "whatsapp:high-brain-classification-registration" },
      { pluginId: "whatsapp", capability: "discord:high-brain-classification-registration" },
      { pluginId: "whatsapp", capability: "whatsapp:high-brain-classification" },
      { pluginId: "whatsapp", capability: "whatsapp:high-brain-classification-registration:extra" },
    ];
    for (const params of negatives) {
      expect(
        resolveBundledChannelRuntimeDependency(params),
        `${params.pluginId} + ${params.capability}`,
      ).toBeUndefined();
    }
  });

  it("injected High Brain registrar and routing claim share the same registry", () => {
    const registrar = resolveBundledChannelRuntimeDependency({
      pluginId: "whatsapp",
      capability: "whatsapp:high-brain-classification-registration",
    }) as typeof registerBrunoHighBrainOverride | undefined;
    expect(registrar).toBeDefined();
    if (!registrar) return;

    const now = Date.now();
    registrar({
      policyVersion: 1,
      sourceEventId: "probe-event",
      mode: "dm",
      requestedTier: "high",
      createdAt: now,
      expiresAt: now + 120_000,
    });

    const first = claimBrunoHighBrainOverrideForRouting("probe-event", now + 1);
    expect(first.status).toBe("authorized");
    const second = claimBrunoHighBrainOverrideForRouting("probe-event", now + 2);
    expect(second).toMatchObject({ status: "denied", reason: "already_consumed" });
  });
});
