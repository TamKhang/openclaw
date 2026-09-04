import { describe, expect, it, vi } from "vitest";
import type { AgentToolResult } from "../agents/runtime/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type {
  PluginRecord,
  PluginRegistry,
  PluginToolRegistration,
} from "../plugins/registry-types.js";
import {
  FIXED_READ_PROJECTION_ID,
  invokeReadProjectionFromRegistry,
  READ_PROJECTION_MAX_OUTPUT_BYTES,
  resolveReadProjectionStatusFromRegistry,
} from "./read-projection.js";

const config = {} as OpenClawConfig;

type ToolExecute = (
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
) => Promise<AgentToolResult<unknown>>;

function createSourceStatusTool(
  execute: ToolExecute = async () => ({
    content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }],
    details: undefined,
  }),
) {
  return {
    name: FIXED_READ_PROJECTION_ID,
    label: "Source status",
    description: "fixed source status",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute,
  };
}

function createSafeRegistry(overrides?: {
  plugin?: Partial<PluginRecord>;
  tool?: Partial<PluginToolRegistration>;
  metadata?: Partial<PluginRegistry["toolMetadata"][number]>;
}): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  registry.plugins.push({
    id: "bruno-knowledge-flow",
    name: "Bruno Knowledge Flow",
    status: "loaded",
    ...overrides?.plugin,
  } as PluginRecord);
  registry.tools.push({
    pluginId: "bruno-knowledge-flow",
    factory: () => createSourceStatusTool(),
    names: [FIXED_READ_PROJECTION_ID],
    declaredNames: [FIXED_READ_PROJECTION_ID],
    optional: false,
    source: "test",
    ...overrides?.tool,
  } as PluginToolRegistration);
  registry.toolMetadata.push({
    pluginId: "bruno-knowledge-flow",
    pluginName: "Bruno Knowledge Flow",
    metadata: {
      toolName: FIXED_READ_PROJECTION_ID,
      safeReadProjection: { capabilities: ["status-read"] },
    },
    source: "test",
    rootDir: undefined,
    ...overrides?.metadata,
  } as PluginRegistry["toolMetadata"][number]);
  return registry;
}

describe("fixed read-projection boundary", () => {
  it("accepts the known registered safe projection with empty input", async () => {
    const registry = createSafeRegistry();
    const outcome = await invokeReadProjectionFromRegistry({
      registry,
      projectionId: FIXED_READ_PROJECTION_ID,
      input: {},
      config,
    });

    expect(outcome).toEqual({
      ok: true,
      projection: FIXED_READ_PROJECTION_ID,
      result: { status: "ok" },
    });
  });

  it("denies an unknown projection", async () => {
    const outcome = await invokeReadProjectionFromRegistry({
      registry: createSafeRegistry(),
      projectionId: "some_other_tool",
      input: {},
      config,
    });

    expect(outcome).toMatchObject({
      ok: false,
      projection: "some_other_tool",
      error: { code: "projection_unknown" },
    });
  });

  it("rejects non-empty input", async () => {
    const outcome = await invokeReadProjectionFromRegistry({
      registry: createSafeRegistry(),
      projectionId: FIXED_READ_PROJECTION_ID,
      input: { path: "/tmp/secret" },
      config,
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("rejects path-like, command-like, provider/source-selector, and arbitrary JSON input", async () => {
    const invalidInputs = [
      { path: "/tmp/secret" },
      { command: "whoami" },
      { provider: "openai" },
      { source: "bruno-knowledge-flow" },
      { tool: FIXED_READ_PROJECTION_ID, plugin: "bruno-knowledge-flow", args: {} },
    ];

    for (const input of invalidInputs) {
      const outcome = await invokeReadProjectionFromRegistry({
        registry: createSafeRegistry(),
        projectionId: FIXED_READ_PROJECTION_ID,
        input,
        config,
      });
      expect(outcome).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
  });

  it("denies an unmarked tool", async () => {
    const registry = createSafeRegistry();
    registry.toolMetadata[0]!.metadata.safeReadProjection = undefined;
    const outcome = await invokeReadProjectionFromRegistry({
      registry,
      projectionId: FIXED_READ_PROJECTION_ID,
      input: {},
      config,
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "projection_not_registered" },
    });
  });

  it("denies an unavailable plugin", async () => {
    const registry = createSafeRegistry({ plugin: { status: "disabled" } });
    const outcome = await invokeReadProjectionFromRegistry({
      registry,
      projectionId: FIXED_READ_PROJECTION_ID,
      input: {},
      config,
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "plugin_unavailable" },
    });
  });

  it("denies an unavailable tool", async () => {
    const registry = createSafeRegistry();
    registry.tools = [];
    const outcome = await invokeReadProjectionFromRegistry({
      registry,
      projectionId: FIXED_READ_PROJECTION_ID,
      input: {},
      config,
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "tool_unavailable" },
    });
  });

  it("denies retrieval, message, shell, and provider capability declarations", async () => {
    const deniedCapabilities = [["retrieval"], ["message"], ["shell"], ["provider"]] as const;

    for (const capabilities of deniedCapabilities) {
      const registry = createSafeRegistry();
      registry.toolMetadata[0]!.metadata.safeReadProjection = {
        capabilities,
      } as never;
      const outcome = await invokeReadProjectionFromRegistry({
        registry,
        projectionId: FIXED_READ_PROJECTION_ID,
        input: {},
        config,
      });

      expect(outcome).toMatchObject({
        ok: false,
        error: { code: "tool_not_safe_read" },
      });
    }
  });

  it("fails on a malformed response", async () => {
    const registry = createSafeRegistry({
      tool: {
        factory: () =>
          createSourceStatusTool(async () => ({
            content: [{ type: "text", text: "not-json" }],
            details: undefined,
          })),
      },
    });
    const outcome = await invokeReadProjectionFromRegistry({
      registry,
      projectionId: FIXED_READ_PROJECTION_ID,
      input: {},
      config,
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "malformed_response" },
    });
  });

  it("fails on an oversized response without truncating", async () => {
    const large = "x".repeat(READ_PROJECTION_MAX_OUTPUT_BYTES + 1024);
    const registry = createSafeRegistry({
      tool: {
        factory: () =>
          createSourceStatusTool(async () => ({
            content: [{ type: "text", text: JSON.stringify({ data: large }) }],
            details: undefined,
          })),
      },
    });
    const outcome = await invokeReadProjectionFromRegistry({
      registry,
      projectionId: FIXED_READ_PROJECTION_ID,
      input: {},
      config,
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "oversized_response" },
    });
  });

  it("fails closed on timeout", async () => {
    const registry = createSafeRegistry({
      tool: {
        factory: () =>
          createSourceStatusTool(async () => new Promise<AgentToolResult<unknown>>(() => {})),
      },
    });
    const outcome = await invokeReadProjectionFromRegistry({
      registry,
      projectionId: FIXED_READ_PROJECTION_ID,
      input: {},
      config,
      timeoutMs: 5,
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  it("exposes bounded registration introspection without executing tools", () => {
    const execute = vi.fn<ToolExecute>(async () => ({
      content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }],
      details: undefined,
    }));
    const registry = createSafeRegistry({
      tool: { factory: () => createSourceStatusTool(execute) },
    });

    const status = resolveReadProjectionStatusFromRegistry(registry, FIXED_READ_PROJECTION_ID);

    expect(status).toEqual({
      projection: FIXED_READ_PROJECTION_ID,
      pluginLoaded: true,
      declarationRegistered: true,
      runtimeRegistered: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
