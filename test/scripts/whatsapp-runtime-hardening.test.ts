// Compiled-artifact certification for the WhatsApp outbound-authorization
// registrar hardening. Rebuilds the externalized WhatsApp package and then
// verifies the private registrar binding is a single shared module-lexical
// slot with no public runtime-store key, no production reset export, and no
// private registration import.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WHATSAPP_DIST = path.join(REPO_ROOT, "extensions", "whatsapp", "dist");
const FORMER_REGISTRAR_KEY = "plugin-runtime:whatsapp:outbound-authorization-registrar";
const RESET_EXPORT = "resetWhatsAppOutboundAuthorizationRegistrar";
const HIGH_BRAIN_RESET_EXPORT = "resetWhatsAppHighBrainClassificationRegistrar";
const HIGH_BRAIN_BINDING = "let highBrainClassificationRegistrar";
const HIGH_BRAIN_CORE_REGISTRAR = "registerBrunoHighBrainOverride";
const PRIVATE_REGISTRATION_SUBPATH = "whatsapp-outbound-authorization-registration";

function buildWhatsAppPackage(): void {
  const result = spawnSync(
    process.execPath,
    ["scripts/lib/plugin-npm-runtime-build.mjs", "extensions/whatsapp"],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, OPENCLAW_BUILD_CACHE: "0" } },
  );
  if (result.status !== 0) {
    throw new Error(
      `whatsapp package build failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
}

function readDistFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of fs.readdirSync(WHATSAPP_DIST)) {
    if (!name.endsWith(".js")) {
      continue;
    }
    files.set(name, fs.readFileSync(path.join(WHATSAPP_DIST, name), "utf8"));
  }
  return files;
}

function importedChunk(entrySource: string): string | null {
  const match = /from\s+["']\.\/([^"']+\.js)["']/u.exec(entrySource);
  return match?.[1] ?? null;
}

describe("compiled WhatsApp registrar hardening", () => {
  it("certifies the compiled runtime after a clean package build", () => {
    buildWhatsAppPackage();
    const dist = readDistFiles();

    // 1. The former predictable runtime-store key must be absent everywhere.
    for (const [name, source] of dist) {
      expect(source, `former key leaked into ${name}`).not.toContain(FORMER_REGISTRAR_KEY);
    }

    // 2. The High Brain registrar reset must also be absent from compiled output,
    // and the externalized package must never import the core High Brain registrar.
    for (const [name, source] of dist) {
      expect(source, `High Brain reset leaked into ${name}`).not.toContain(HIGH_BRAIN_RESET_EXPORT);
    }
    for (const [name, source] of dist) {
      expect(source, `core High Brain registrar import leaked into ${name}`).not.toContain(
        HIGH_BRAIN_CORE_REGISTRAR,
      );
    }

    // 2b. No compiled production entry may export or reference a reset operation.
    for (const [name, source] of dist) {
      expect(source, `reset leaked into ${name}`).not.toContain(RESET_EXPORT);
    }

    // 3. The private registration subpath must not appear in any compiled import.
    for (const [name, source] of dist) {
      expect(source, `private registration import leaked into ${name}`).not.toContain(
        PRIVATE_REGISTRATION_SUBPATH,
      );
    }

    // 4. The delegated_group_reply discriminator survives compilation.
    const compiledText = [...dist.values()].join("\n");
    expect(compiledText).toContain("delegated_group_reply");

    // 5. The setter sidecar and the monitor consumer share one runtime chunk.
    const setterEntry = dist.get("runtime-setter-api.js");
    expect(setterEntry).toBeDefined();
    const setterChunk = importedChunk(setterEntry ?? "");
    expect(setterChunk).toBeDefined();
    const runtimeChunk = dist.get(setterChunk ?? "");
    expect(runtimeChunk).toBeDefined();

    // 6. Exactly one private module-lexical registrar binding exists.
    const bindingMatches = (runtimeChunk ?? "").match(/\blet outboundAuthorizationRegistrar\b/gu);
    expect(bindingMatches).toHaveLength(1);

    // 6b. Exactly one private module-lexical High Brain registrar binding exists
    // in the same shared runtime chunk (setter sidecar and monitor consumer).
    const highBrainBindingMatches = (runtimeChunk ?? "").match(
      new RegExp(`\\b${HIGH_BRAIN_BINDING}\\b`, "gu"),
    );
    expect(highBrainBindingMatches).toHaveLength(1);

    const monitorChunks = [...dist.keys()].filter((name) => name.startsWith("monitor-"));
    expect(monitorChunks.length).toBeGreaterThan(0);
    const sharedMonitorImport = monitorChunks.some((name) =>
      (dist.get(name) ?? "").includes(`from "./${setterChunk}"`),
    );
    expect(sharedMonitorImport).toBe(true);
  });
});
