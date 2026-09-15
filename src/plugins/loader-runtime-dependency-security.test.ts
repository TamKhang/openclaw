// Hostile-plugin coverage for the bundled runtime-dependency injection gate.
//
// The outbound-authorization registrar must be injectable only into the
// authentic bundled WhatsApp implementation. These tests load hostile plugins
// (config, global, workspace, and duplicate-precedence overrides) that claim
// the canonical id/capability and prove their plugin-controlled setter is
// neither read nor invoked.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { registerWhatsAppOutboundAuthorization } from "../infra/outbound/whatsapp-outbound-authorization.js";
import { withEnv } from "../test-utils/env.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "./loader.test-fixtures.js";

const CAPABILITY = "whatsapp:outbound-authorization-registration";

type Marker = { setterRead: boolean; setterCalled: boolean; deps: unknown };

const markerKeys = new Set<string>();

function readMarker(markerKey: string): Marker | undefined {
  return (globalThis as Record<string, unknown>)[markerKey] as Marker | undefined;
}

function writeHostileConfigPlugin(id: string): {
  markerKey: string;
  plugin: { dir: string; file: string };
} {
  useNoBundledPlugins();
  const markerKey = `__runtimeDependencyProbe_config_${id}_${Math.random().toString(36).slice(2)}`;
  markerKeys.add(markerKey);
  const dir = makePluginLoaderTempDir();
  const file = path.join(dir, `${id}.cjs`);
  fs.writeFileSync(file, hostileEntryBody(markerKey, id), "utf8");
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({ id, configSchema: EMPTY_PLUGIN_SCHEMA }, null, 2),
    "utf8",
  );
  return { markerKey, plugin: { dir, file } };
}

function hostileEntryBody(markerKey: string, id: string, capability: string = CAPABILITY): string {
  return `globalThis[${JSON.stringify(markerKey)}] = { setterRead: false, setterCalled: false, deps: undefined };
const entry = {
  id: ${JSON.stringify(id)},
  kind: "bundled-channel-entry",
  register() {},
  runtimeDependencyCapability: ${JSON.stringify(capability)},
};
Object.defineProperty(entry, "setChannelRuntimeDependencies", {
  enumerable: true,
  configurable: true,
  get() {
    globalThis[${JSON.stringify(markerKey)}].setterRead = true;
    return function setter(deps) {
      globalThis[${JSON.stringify(markerKey)}].setterCalled = true;
      globalThis[${JSON.stringify(markerKey)}].deps = deps;
    };
  },
});
module.exports = entry;`;
}

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  for (const key of markerKeys) {
    delete (globalThis as Record<string, unknown>)[key];
  }
  markerKeys.clear();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("bundled runtime-dependency injection trust gate", () => {
  it("denies a config plugin claiming id whatsapp", () => {
    const { markerKey, plugin } = writeHostileConfigPlugin("whatsapp");
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["whatsapp"],
          entries: { whatsapp: { enabled: true } },
        },
      },
    });
    const record = registry.plugins.find((entry) => entry.id === "whatsapp");
    expect(record?.status).toBe("loaded");
    expect(record?.origin).toBe("config");
    expect(readMarker(markerKey)).toMatchObject({ setterRead: false, setterCalled: false });
  });

  it("denies an installed/global plugin claiming id whatsapp", () => {
    useNoBundledPlugins();
    const stateDir = makePluginLoaderTempDir();
    const markerKey = `__runtimeDependencyProbe_global_${Math.random().toString(36).slice(2)}`;
    markerKeys.add(markerKey);
    const globalDir = path.join(stateDir, "extensions", "whatsapp");
    mkdirSafe(globalDir);
    fs.writeFileSync(
      path.join(globalDir, "index.cjs"),
      hostileEntryBody(markerKey, "whatsapp"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(globalDir, "openclaw.plugin.json"),
      JSON.stringify(
        { id: "whatsapp", configSchema: EMPTY_PLUGIN_SCHEMA, channels: ["whatsapp"] },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(globalDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/whatsapp-evil",
          version: "0.0.0-test",
          main: "./index.cjs",
          openclaw: { extensions: ["./index.cjs"] },
        },
        null,
        2,
      ),
      "utf8",
    );

    const registry = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      loadOpenClawPlugins({
        cache: false,
        config: {
          plugins: {
            enabled: true,
            allow: ["whatsapp"],
            entries: { whatsapp: { enabled: true } },
          },
        },
      }),
    );

    const record = registry.plugins.find((entry) => entry.id === "whatsapp");
    expect(record?.status).toBe("loaded");
    expect(record?.origin).toBe("global");
    expect(readMarker(markerKey)).toMatchObject({ setterRead: false, setterCalled: false });
  });

  it("denies a workspace plugin claiming id whatsapp", () => {
    useNoBundledPlugins();
    const workspaceDir = makePluginLoaderTempDir();
    const markerKey = `__runtimeDependencyProbe_workspace_${Math.random().toString(36).slice(2)}`;
    markerKeys.add(markerKey);
    const pluginDir = path.join(workspaceDir, ".openclaw", "extensions", "whatsapp");
    mkdirSafe(pluginDir);
    fs.writeFileSync(
      path.join(pluginDir, "index.cjs"),
      hostileEntryBody(markerKey, "whatsapp"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        { id: "whatsapp", configSchema: EMPTY_PLUGIN_SCHEMA, channels: ["whatsapp"] },
        null,
        2,
      ),
      "utf8",
    );

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir,
      config: {
        plugins: {
          enabled: true,
          allow: ["whatsapp"],
          entries: { whatsapp: { enabled: true } },
        },
      },
    });

    const record = registry.plugins.find((entry) => entry.id === "whatsapp");
    expect(record?.status).toBe("loaded");
    expect(record?.origin).toBe("workspace");
    expect(readMarker(markerKey)).toMatchObject({ setterRead: false, setterCalled: false });
  });

  it("denies a non-whatsapp plugin that declares the WhatsApp capability", () => {
    const { markerKey, plugin } = writeHostileConfigPlugin("evil-channel");
    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["evil-channel"],
          entries: { "evil-channel": { enabled: true } },
        },
      },
    });
    const record = registry.plugins.find((entry) => entry.id === "evil-channel");
    expect(record?.status).toBe("loaded");
    expect(readMarker(markerKey)).toMatchObject({ setterRead: false, setterCalled: false });
  });

  it("denies a bundled non-WhatsApp channel requesting its own-namespaced registrar capability", () => {
    // A bundled channel entry (origin "bundled") whose id equals its own
    // capability owner prefix must still never receive the WhatsApp registrar:
    // only the exact canonical whatsapp pair resolves.
    useNoBundledPlugins();
    const bundledDir = makePluginLoaderTempDir();
    const markerKey = `__runtimeDependencyProbe_bundled_discord_${Math.random().toString(36).slice(2)}`;
    markerKeys.add(markerKey);
    fs.writeFileSync(
      path.join(bundledDir, "discord.cjs"),
      hostileEntryBody(markerKey, "discord", "discord:outbound-authorization-registration"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(bundledDir, "openclaw.plugin.json"),
      JSON.stringify(
        { id: "discord", configSchema: EMPTY_PLUGIN_SCHEMA, channels: ["discord"] },
        null,
        2,
      ),
      "utf8",
    );

    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      },
      () =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              entries: { discord: { enabled: true } },
            },
          },
        }),
    );

    const record = registry.plugins.find((entry) => entry.id === "discord");
    expect(record?.status).toBe("loaded");
    expect(record?.origin).toBe("bundled");
    expect(readMarker(markerKey)).toMatchObject({ setterRead: true, setterCalled: false });
    expect(readMarker(markerKey)?.deps).toBeUndefined();
  });

  it("does not read or invoke a plugin-controlled setter when provenance is untrusted", () => {
    // The hostile setter is wrapped in a getter that records access. A denied
    // request must never access (resolve) it, let alone invoke it.
    const { markerKey, plugin } = writeHostileConfigPlugin("whatsapp");
    loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["whatsapp"],
          entries: { whatsapp: { enabled: true } },
        },
      },
    });
    expect(readMarker(markerKey)).toMatchObject({ setterRead: false, setterCalled: false });
  });

  it("does not let duplicate-precedence replacement inherit bundled trust", () => {
    // A config-selected plugin (rank 0) replaces the bundled WhatsApp (rank 3).
    // The winner keeps origin "config", so bundled trust must not transfer.
    const bundledDir = makePluginLoaderTempDir();
    const bundledMarkerKey = `__runtimeDependencyProbe_bundled_${Math.random().toString(36).slice(2)}`;
    markerKeys.add(bundledMarkerKey);
    fs.writeFileSync(
      path.join(bundledDir, "whatsapp.cjs"),
      hostileEntryBody(bundledMarkerKey, "whatsapp"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(bundledDir, "openclaw.plugin.json"),
      JSON.stringify(
        { id: "whatsapp", configSchema: EMPTY_PLUGIN_SCHEMA, channels: ["whatsapp"] },
        null,
        2,
      ),
      "utf8",
    );

    const { markerKey, plugin } = writeHostileConfigPlugin("whatsapp");

    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      },
      () =>
        loadOpenClawPlugins({
          cache: false,
          workspaceDir: plugin.dir,
          config: {
            plugins: {
              load: { paths: [plugin.file] },
              allow: ["whatsapp"],
              entries: { whatsapp: { enabled: true } },
            },
          },
        }),
    );

    const record = registry.plugins.find((entry) => entry.id === "whatsapp");
    expect(record?.status).toBe("loaded");
    expect(record?.origin).toBe("config");
    expect(readMarker(markerKey)).toMatchObject({ setterRead: false, setterCalled: false });
    // The bundled candidate was overridden, so its entry module must never load
    // (no marker is installed) and its setter can never receive the registrar.
    expect(readMarker(bundledMarkerKey)).toBeUndefined();
  });

  it("injects the exact core singleton registrar into the authentic bundled WhatsApp", () => {
    useNoBundledPlugins();
    const bundledDir = makePluginLoaderTempDir();
    const markerKey = `__runtimeDependencyProbe_bundled_ok_${Math.random().toString(36).slice(2)}`;
    markerKeys.add(markerKey);
    fs.writeFileSync(
      path.join(bundledDir, "whatsapp.cjs"),
      hostileEntryBody(markerKey, "whatsapp"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(bundledDir, "openclaw.plugin.json"),
      JSON.stringify(
        { id: "whatsapp", configSchema: EMPTY_PLUGIN_SCHEMA, channels: ["whatsapp"] },
        null,
        2,
      ),
      "utf8",
    );

    const registry = withEnv(
      {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_STATE_DIR: makePluginLoaderTempDir(),
      },
      () =>
        loadOpenClawPlugins({
          cache: false,
          config: {
            plugins: {
              entries: { whatsapp: { enabled: true } },
            },
          },
        }),
    );

    const record = registry.plugins.find((entry) => entry.id === "whatsapp");
    expect(record?.status).toBe("loaded");
    expect(record?.origin).toBe("bundled");
    expect(readMarker(markerKey)).toMatchObject({ setterRead: true, setterCalled: true });
    expect(readMarker(markerKey)?.deps).toBe(registerWhatsAppOutboundAuthorization);
  });
});
