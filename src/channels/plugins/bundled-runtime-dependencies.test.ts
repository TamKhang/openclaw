// Trusted host runtime-dependency injection must hand the externalized
// WhatsApp channel the core-owned singleton registrar (not a copy), must gate
// injection on host-owned bundled provenance (never plugin-controlled id or
// capability strings), and must never resolve a capability for an untrusted
// plugin id or origin.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimWhatsAppOutboundAuthorizationForTransport,
  registerWhatsAppOutboundAuthorization,
  resetWhatsAppOutboundAuthorizationForTests,
  WHATSAPP_GROUP_REPLY_ONCE_CAPABILITY,
} from "../../infra/outbound/whatsapp-outbound-authorization.js";
import {
  isTrustedBundledChannelRuntimeDependencyRequest,
  resolveBundledChannelRuntimeDependency,
} from "./bundled-runtime-dependencies.js";

type Registrar = Parameters<typeof registerWhatsAppOutboundAuthorization>[0] extends never
  ? never
  : (permit: Parameters<typeof registerWhatsAppOutboundAuthorization>[0]) => void;

afterEach(() => {
  resetWhatsAppOutboundAuthorizationForTests();
});

function permit() {
  const now = Date.now();
  return {
    authorizationClass: "delegated_group_reply" as const,
    policyVersion: 1 as const,
    actionType: "whatsapp.group.send" as const,
    capability: WHATSAPP_GROUP_REPLY_ONCE_CAPABILITY,
    token: "6d3e5f20-6b3c-4a0e-9f6a-2c9d7e2c4a1f",
    ownerE164: "+15550000001",
    groupId: "probe-group@g.us",
    chatId: "probe-group@g.us",
    sourceEventId: "source-event-1",
    ownerTriggerMessageId: "trigger-1",
    quotedMessageId: "quoted-1",
    targetParticipantId: "participant-1",
    createdAt: now,
    expiresAt: now + 120_000,
    maxSends: 1 as const,
  };
}

describe("resolveBundledChannelRuntimeDependency", () => {
  it("resolves the exact core singleton registrar only for the exact canonical whatsapp pair", () => {
    const registrar = resolveBundledChannelRuntimeDependency({
      pluginId: "whatsapp",
      capability: "whatsapp:outbound-authorization-registration",
    });
    expect(registrar).toBe(registerWhatsAppOutboundAuthorization);
    expect(typeof registrar).toBe("function");
  });

  it("returns undefined for every non-canonical or mismatched pair", () => {
    const negatives = [
      { pluginId: "discord", capability: "discord:outbound-authorization-registration" },
      { pluginId: "slack", capability: "slack:outbound-authorization-registration" },
      { pluginId: "discord", capability: "whatsapp:outbound-authorization-registration" },
      { pluginId: "whatsapp", capability: "discord:outbound-authorization-registration" },
      { pluginId: "whatsapp", capability: "whatsapp:unknown-capability" },
      { pluginId: "whatsapp", capability: "whatsapp:outbound-authorization-registration:extra" },
    ];
    for (const params of negatives) {
      expect(
        resolveBundledChannelRuntimeDependency(params),
        `${params.pluginId} + ${params.capability}`,
      ).toBeUndefined();
    }
  });

  it("injected registrar and transport gate share the same registry", () => {
    const registrar = resolveBundledChannelRuntimeDependency({
      pluginId: "whatsapp",
      capability: "whatsapp:outbound-authorization-registration",
    }) as Registrar | undefined;
    expect(registrar).toBeDefined();
    if (!registrar) return;

    const minted = permit();
    registrar(minted);

    const claim = claimWhatsAppOutboundAuthorizationForTransport({
      to: minted.chatId,
      channel: "whatsapp",
      authorization: minted,
      originEventId: minted.sourceEventId,
    });
    expect(claim.status).toBe("authorized");

    const secondClaim = claimWhatsAppOutboundAuthorizationForTransport({
      to: minted.chatId,
      channel: "whatsapp",
      authorization: minted,
      originEventId: minted.sourceEventId,
    });
    expect(secondClaim.status).toBe("denied");
    expect(secondClaim.status === "denied" ? secondClaim.reasonCode : "").toBe("consumed_permit");
  });

  it("keeps the registrar out of the public package export surface", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "../../../package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };
    const publicSubpaths = Object.keys(packageJson.exports ?? {});
    expect(publicSubpaths.filter((key) => key.includes("whatsapp-outbound-authorization"))).toEqual(
      ["./plugin-sdk/whatsapp-outbound-authorization"],
    );
  });
});

describe("isTrustedBundledChannelRuntimeDependencyRequest", () => {
  it("rejects every non-bundled origin regardless of id, kind, or capability", () => {
    for (const origin of ["config", "global", "workspace", undefined] as const) {
      expect(
        isTrustedBundledChannelRuntimeDependencyRequest({
          origin,
          kind: "bundled-channel-entry",
        }),
      ).toBe(false);
    }
  });

  it("rejects bundled origin without the bundled-channel-entry kind", () => {
    expect(
      isTrustedBundledChannelRuntimeDependencyRequest({ origin: "bundled", kind: undefined }),
    ).toBe(false);
    expect(
      isTrustedBundledChannelRuntimeDependencyRequest({ origin: "bundled", kind: "channel" }),
    ).toBe(false);
    expect(
      isTrustedBundledChannelRuntimeDependencyRequest({
        origin: "bundled",
        kind: ["memory", "context-engine"],
      }),
    ).toBe(false);
  });

  it("accepts only authentic bundled-channel-entry provenance", () => {
    expect(
      isTrustedBundledChannelRuntimeDependencyRequest({
        origin: "bundled",
        kind: "bundled-channel-entry",
      }),
    ).toBe(true);
    expect(
      isTrustedBundledChannelRuntimeDependencyRequest({
        origin: "bundled",
        kind: ["bundled-channel-entry"],
      }),
    ).toBe(true);
  });
});
