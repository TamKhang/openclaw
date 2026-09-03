// Fixed in-process read-projection boundary for plugin-owned tools.
//
// The boundary is intentionally not a generic plugin/tool dispatcher. It only
// recognizes the fixed projection ids below and requires a matching plugin
// tool-metadata safe-read declaration plus a registered plugin tool. Input is
// empty, output is sanitized and bounded, and every failure is fail-closed.

import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistryWorkspaceDir } from "../plugins/runtime.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { normalizeSafeReadProjection } from "../plugins/safe-read-projection.js";
import { ensureStandalonePluginToolRegistryLoaded } from "../plugins/tools.js";
import type { OpenClawPluginToolContext } from "../plugins/types.js";
import { withTimeout } from "../utils/with-timeout.js";

export const FIXED_READ_PROJECTION_ID = "bruno_knowledge_flow_get_source_status";
export const READ_PROJECTION_TIMEOUT_MS = 2_000;
export const READ_PROJECTION_MAX_OUTPUT_BYTES = 64 * 1024;
export const READ_PROJECTION_MAX_DEPTH = 16;
export const READ_PROJECTION_MAX_ITEMS = 1_000;

const FIXED_READ_PROJECTION_IDS: ReadonlySet<string> = new Set([FIXED_READ_PROJECTION_ID]);

type ReadProjectionRegistryView = Pick<PluginRegistry, "plugins" | "tools" | "toolMetadata">;

type ReadProjectionMetadataEntry = ReadProjectionRegistryView["toolMetadata"][number];
type ReadProjectionToolEntry = ReadProjectionRegistryView["tools"][number];

export type ReadProjectionFailureCode =
  | "projection_unknown"
  | "projection_not_registered"
  | "plugin_unavailable"
  | "tool_unavailable"
  | "tool_not_safe_read"
  | "invalid_input"
  | "timeout"
  | "malformed_response"
  | "oversized_response"
  | "execution_rejected"
  | "internal_failure";

export type ReadProjectionFailure = {
  code: ReadProjectionFailureCode;
  message: string;
};

export type ReadProjectionSuccess = {
  ok: true;
  projection: string;
  result: unknown;
};

export type ReadProjectionOutcome =
  | ReadProjectionSuccess
  | {
      ok: false;
      projection: string;
      error: ReadProjectionFailure;
    };

export type ReadProjectionStatus = {
  projection: string;
  pluginLoaded: boolean;
  declarationRegistered: boolean;
  runtimeRegistered: boolean;
};

type ResolvedReadProjectionTarget = {
  pluginId: string;
  metadataEntry: ReadProjectionMetadataEntry;
  toolEntry: ReadProjectionToolEntry;
};

function failure(
  code: ReadProjectionFailureCode,
  projection: string,
  message?: string,
): Extract<ReadProjectionOutcome, { ok: false }> {
  const boundedMessages: Record<ReadProjectionFailureCode, string> = {
    projection_unknown: "read projection is not allowed",
    projection_not_registered: "read projection is not registered",
    plugin_unavailable: "read projection plugin is not loaded",
    tool_unavailable: "read projection tool is not registered",
    tool_not_safe_read: "read projection tool is not marked safe-read",
    invalid_input: "read projection accepts empty input only",
    timeout: "read projection timed out",
    malformed_response: "read projection returned a malformed response",
    oversized_response: "read projection response exceeded the size bound",
    execution_rejected: "read projection execution was rejected",
    internal_failure: "read projection failed",
  };
  return {
    ok: false,
    projection,
    error: { code, message: message ?? boundedMessages[code] },
  };
}

function isAllowedProjectionId(projectionId: string): boolean {
  return FIXED_READ_PROJECTION_IDS.has(projectionId);
}

function assertEmptyInput(input: Record<string, unknown>): ReadProjectionFailure | undefined {
  return Object.keys(input).length === 0
    ? undefined
    : failure("invalid_input", FIXED_READ_PROJECTION_ID).error;
}

function resolveProjectionMetadata(
  registry: ReadProjectionRegistryView,
  projectionId: string,
): ReadProjectionMetadataEntry | undefined {
  return registry.toolMetadata.find(
    (entry) =>
      entry.metadata.toolName === projectionId && entry.metadata.safeReadProjection !== undefined,
  );
}

function resolveProjectionTool(
  registry: ReadProjectionRegistryView,
  pluginId: string,
  projectionId: string,
): ReadProjectionToolEntry | undefined {
  return registry.tools.find(
    (entry) =>
      entry.pluginId === pluginId &&
      (entry.names.includes(projectionId) || entry.declaredNames?.includes(projectionId) === true),
  );
}

function resolveReadProjectionTarget(
  registry: ReadProjectionRegistryView,
  projectionId: string,
  input: Record<string, unknown>,
):
  | { ok: true; target: ResolvedReadProjectionTarget }
  | { ok: false; error: ReadProjectionFailure; projection: string } {
  if (!isAllowedProjectionId(projectionId)) {
    return {
      ok: false,
      projection: projectionId,
      error: failure("projection_unknown", projectionId).error,
    };
  }
  const inputError = assertEmptyInput(input);
  if (inputError) {
    return { ok: false, projection: projectionId, error: inputError };
  }
  const metadataEntry = resolveProjectionMetadata(registry, projectionId);
  if (!metadataEntry) {
    return {
      ok: false,
      projection: projectionId,
      error: failure("projection_not_registered", projectionId).error,
    };
  }
  const safeRead = normalizeSafeReadProjection(metadataEntry.metadata.safeReadProjection);
  if (!safeRead.ok) {
    return {
      ok: false,
      projection: projectionId,
      error: failure("tool_not_safe_read", projectionId).error,
    };
  }
  const plugin = registry.plugins.find((candidate) => candidate.id === metadataEntry.pluginId);
  if (!plugin || plugin.status !== "loaded") {
    return {
      ok: false,
      projection: projectionId,
      error: failure("plugin_unavailable", projectionId).error,
    };
  }
  const toolEntry = resolveProjectionTool(registry, metadataEntry.pluginId, projectionId);
  if (!toolEntry) {
    return {
      ok: false,
      projection: projectionId,
      error: failure("tool_unavailable", projectionId).error,
    };
  }
  return {
    ok: true,
    target: {
      pluginId: metadataEntry.pluginId,
      metadataEntry,
      toolEntry,
    },
  };
}

function createReadProjectionToolContext(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
}): OpenClawPluginToolContext {
  return {
    config: params.config,
    runtimeConfig: params.config,
    getRuntimeConfig: () => params.config,
    workspaceDir: params.workspaceDir,
  };
}

function isAgentTool(value: unknown): value is {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<unknown>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { execute?: unknown }).execute === "function"
  );
}

function sanitizeJsonValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > READ_PROJECTION_MAX_DEPTH) {
    throw new Error("malformed response");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("malformed response");
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new Error("malformed response");
  }
  if (seen.has(value)) {
    throw new Error("malformed response");
  }
  seen.add(value);
  if (Array.isArray(value)) {
    if (value.length > READ_PROJECTION_MAX_ITEMS) {
      throw new Error("oversized response");
    }
    return value.map((entry) => sanitizeJsonValue(entry, seen, depth + 1));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("malformed response");
  }
  const keys = Object.keys(value).toSorted();
  if (keys.length > READ_PROJECTION_MAX_ITEMS) {
    throw new Error("oversized response");
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    Object.defineProperty(output, key, {
      value: sanitizeJsonValue((value as Record<string, unknown>)[key], seen, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

function extractReadProjectionResult(rawResult: unknown): unknown {
  if (typeof rawResult !== "object" || rawResult === null) {
    throw new Error("malformed response");
  }
  const result = rawResult as {
    details?: unknown;
    content?: unknown;
  };
  if (result.details !== undefined) {
    return result.details;
  }
  if (!Array.isArray(result.content)) {
    throw new Error("malformed response");
  }
  const textParts: string[] = [];
  for (const block of result.content) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      textParts.push(candidate.text);
    }
  }
  if (textParts.length === 0) {
    throw new Error("malformed response");
  }
  const joined = textParts.join("\n");
  try {
    return JSON.parse(joined) as unknown;
  } catch {
    throw new Error("malformed response");
  }
}

function boundReadProjectionResult(rawResult: unknown): unknown {
  const extracted = extractReadProjectionResult(rawResult);
  const sanitized = sanitizeJsonValue(extracted, new WeakSet(), 0);
  const serialized = JSON.stringify(sanitized);
  if (typeof serialized !== "string") {
    throw new Error("malformed response");
  }
  if (Buffer.byteLength(serialized, "utf8") > READ_PROJECTION_MAX_OUTPUT_BYTES) {
    throw new Error("oversized response");
  }
  return sanitized;
}

function isAbortOrTimeout(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted ||
    (error instanceof Error && (error.name === "TimeoutError" || /timed out/i.test(error.message)))
  );
}

async function resolveAndExecuteTool(params: {
  registry: ReadProjectionRegistryView;
  target: ResolvedReadProjectionTarget;
  projectionId: string;
  config: OpenClawConfig;
  workspaceDir?: string;
  timeoutMs: number;
}): Promise<unknown> {
  const { target, registry, projectionId } = params;
  const toolContext = createReadProjectionToolContext({
    config: params.config,
    workspaceDir: params.workspaceDir,
  });
  const signal = AbortSignal.timeout(params.timeoutMs);
  let tool: unknown;
  try {
    tool = await withTimeout(
      Promise.resolve().then(() =>
        withPluginRuntimeRegistryScope(registry as PluginRegistry, () =>
          withPluginRuntimePluginScope(
            {
              pluginId: target.pluginId,
              ...(target.toolEntry.source ? { pluginSource: target.toolEntry.source } : {}),
            },
            () => {
              const resolved = target.toolEntry.factory(toolContext);
              const list = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
              return list.find(
                (candidate) => isAgentTool(candidate) && candidate.name === projectionId,
              );
            },
          ),
        ),
      ),
      params.timeoutMs,
      `read projection ${projectionId}`,
    );
  } catch (error) {
    if (isAbortOrTimeout(error, signal)) {
      throw new Error("timeout", { cause: error });
    }
    throw error;
  }
  if (!isAgentTool(tool)) {
    throw new Error("tool unavailable");
  }
  try {
    return await withTimeout(
      tool.execute(`read-projection:${projectionId}`, {}, signal),
      params.timeoutMs,
      `read projection ${projectionId}`,
    );
  } catch (error) {
    if (isAbortOrTimeout(error, signal)) {
      throw new Error("timeout", { cause: error });
    }
    throw error;
  }
}

/** Executes one fixed read projection from an already-loaded registry view. */
export async function invokeReadProjectionFromRegistry(params: {
  registry: ReadProjectionRegistryView;
  projectionId: string;
  input: Record<string, unknown>;
  config: OpenClawConfig;
  workspaceDir?: string;
  timeoutMs?: number;
}): Promise<ReadProjectionOutcome> {
  const resolved = resolveReadProjectionTarget(params.registry, params.projectionId, params.input);
  if (!resolved.ok) {
    return {
      ok: false,
      projection: resolved.projection,
      error: resolved.error,
    };
  }
  try {
    const rawResult = await resolveAndExecuteTool({
      registry: params.registry,
      target: resolved.target,
      projectionId: params.projectionId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      timeoutMs: params.timeoutMs ?? READ_PROJECTION_TIMEOUT_MS,
    });
    return {
      ok: true,
      projection: params.projectionId,
      result: boundReadProjectionResult(rawResult),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "tool unavailable") {
      return failure("tool_unavailable", params.projectionId);
    }
    if (message === "oversized response") {
      return failure("oversized_response", params.projectionId);
    }
    if (message === "malformed response") {
      return failure("malformed_response", params.projectionId);
    }
    if (message === "timeout") {
      return failure("timeout", params.projectionId);
    }
    return failure("internal_failure", params.projectionId);
  }
}

/** Loads the plugin registry view scoped to one fixed read-projection tool. */
export function loadFixedReadProjectionRegistry(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ReadProjectionRegistryView | undefined {
  return ensureStandalonePluginToolRegistryLoaded({
    context: createReadProjectionToolContext({
      config: params.config,
      workspaceDir: params.workspaceDir,
    }),
    toolAllowlist: [FIXED_READ_PROJECTION_ID],
    env: params.env,
  });
}

/** Reads fixed-projection registration facts without executing any tool. */
export function resolveReadProjectionStatusFromRegistry(
  registry: ReadProjectionRegistryView,
  projectionId: string,
): ReadProjectionStatus {
  const metadataEntry = resolveProjectionMetadata(registry, projectionId);
  const plugin =
    metadataEntry === undefined
      ? undefined
      : registry.plugins.find((candidate) => candidate.id === metadataEntry.pluginId);
  const tool =
    metadataEntry === undefined || plugin === undefined
      ? undefined
      : resolveProjectionTool(registry, plugin.id, projectionId);
  return {
    projection: projectionId,
    pluginLoaded: plugin?.status === "loaded",
    declarationRegistered:
      metadataEntry !== undefined &&
      normalizeSafeReadProjection(metadataEntry.metadata.safeReadProjection).ok,
    runtimeRegistered: tool !== undefined,
  };
}

/** Invokes the fixed projection using the normal plugin registry load path. */
export async function invokeFixedReadProjection(params: {
  projectionId?: string;
  input: Record<string, unknown>;
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ReadProjectionOutcome> {
  const projectionId = params.projectionId ?? FIXED_READ_PROJECTION_ID;
  if (!isAllowedProjectionId(projectionId)) {
    return failure("projection_unknown", projectionId);
  }
  const inputError = assertEmptyInput(params.input);
  if (inputError) {
    return { ok: false, projection: projectionId, error: inputError };
  }
  const registry = loadFixedReadProjectionRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (!registry) {
    return failure("plugin_unavailable", projectionId);
  }
  return await invokeReadProjectionFromRegistry({
    registry,
    projectionId,
    input: params.input,
    config: params.config,
    workspaceDir: params.workspaceDir,
    timeoutMs: params.timeoutMs,
  });
}

/** Returns bounded registration facts for every fixed read projection. */
export function getFixedReadProjectionStatus(params: {
  config: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ReadProjectionStatus[] {
  const registry = loadFixedReadProjectionRegistry({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return [...FIXED_READ_PROJECTION_IDS].map((projectionId) =>
    resolveReadProjectionStatusFromRegistry(
      registry ?? { plugins: [], tools: [], toolMetadata: [] },
      projectionId,
    ),
  );
}

/** Returns the gateway-local workspace dir when one is already resolved. */
export function resolveReadProjectionWorkspaceDir(): string | undefined {
  return getActivePluginRegistryWorkspaceDir();
}
