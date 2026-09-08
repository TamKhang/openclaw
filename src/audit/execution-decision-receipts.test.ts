import { afterEach, describe, expect, it } from "vitest";
import type {
  DecisionReceiptV1,
  ExecutionIdentityContextV1,
} from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  pageExecutionDecisionFactsForContext,
  recordExecutionDecisionFact,
} from "./execution-decision-facts.js";
import { presentExecutionDecisionReceipts } from "./execution-decision-receipts.js";
import {
  configureExecutionIdentityAdmissionSink,
  enqueueExecutionIdentityContextAtAdmission,
  type ExecutionIdentityAdmissionEnvelope,
} from "./execution-identity-admission.js";
import { processExecutionIdentityAdmissionWork } from "./execution-identity-context.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function databaseOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-decision-receipts-") } };
}

function seedExecutionContext(
  database: ReturnType<typeof databaseOptions>,
  overrides: {
    runId?: string;
    contextId?: string;
    executionId?: string;
  } = {},
): ExecutionIdentityContextV1 {
  const runId = overrides.runId ?? "run-1";
  const contextId = overrides.contextId ?? "context-1";
  const executionId = overrides.executionId ?? "execution-1";
  let envelope: ExecutionIdentityAdmissionEnvelope | undefined;
  const clear = configureExecutionIdentityAdmissionSink((work) => {
    if (work.kind === "capture") {
      envelope = work.envelope;
    }
    return true;
  });
  try {
    enqueueExecutionIdentityContextAtAdmission(
      {
        runId,
        agentId: "main",
        ingress: { kind: "local-cli", boundary: "agent-command.local", state: "present" },
        runtime: { kind: "embedded" },
      },
      {
        enabled: true,
        now: 50,
        contextId,
        executionId,
        runtimeInstanceId: "runtime-1",
      },
    );
  } finally {
    clear();
  }
  if (!envelope) {
    throw new Error("expected execution identity envelope");
  }
  const stored = processExecutionIdentityAdmissionWork(
    { kind: "capture", envelope },
    { ...database, now: 50 },
  );
  if (
    stored.contextId !== contextId ||
    stored.executionId !== executionId ||
    stored.runId !== runId
  ) {
    throw new Error(`unexpected execution context: ${JSON.stringify(stored)}`);
  }
  return stored;
}

function receipt(id: string, occurredAt = 100): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: id,
    contextId: "context-1",
    executionId: "execution-1",
    runId: "run-1",
    actionId: `action-${id}`,
    occurredAt,
    action: { family: "tool", operation: "policy" },
    decision: { outcome: "denied", reasonCode: "tool_policy_denied" },
    enforcement: {
      coverageState: "enforced",
      evaluatorRef: "tool-policy",
      policyRefs: ["tool-policy:deny"],
      grantRefs: [],
      contextFieldsUsed: ["runId"],
    },
    source: {
      owner: "tool-policy",
      recordRef: `record-${id}`,
      decisionBoundary: "agent-tool.before-call",
    },
    missingEvidence: [],
    remediation: [{ code: "choose_allowed_tool", text: "Choose an allowed tool and retry." }],
  };
}

function modelRoutingReceipt(id: string, reasonCode: string, occurredAt = 100): DecisionReceiptV1 {
  return {
    schemaVersion: 1,
    receiptId: id,
    contextId: "context-1",
    executionId: "execution-1",
    runId: "run-1",
    occurredAt,
    modelRouting: {
      selectedProvider: "openai",
      selectedModel: "gpt-5.6",
    },
    action: {
      family: "model-routing",
      operation: "automatic-selection",
      summary:
        "Requested unrelated-provider/unrelated-model; selected forged-provider/forged-model.",
    },
    decision: { outcome: "allowed", reasonCode },
    enforcement: {
      coverageState: "attribution-only",
      policyRefs: [],
      grantRefs: [],
      contextFieldsUsed: ["contextId", "executionId", "runId"],
    },
    source: {
      owner: "model-routing",
      recordRef: id,
      decisionBoundary: "agent-runtime.post-admission",
    },
    missingEvidence: [],
    remediation: [],
  };
}

describe("execution decision receipts", () => {
  it("projects only authoritative model routing receipts without raw decision fields", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    recordExecutionDecisionFact(receipt("tool-policy"), { ...database, now: 100 });
    recordExecutionDecisionFact(
      modelRoutingReceipt("model-routing:selected", "model_route_selected"),
      { ...database, now: 100 },
    );

    const result = presentExecutionDecisionReceipts({
      context,
      decisionLimit: 10,
      options: { ...database, now: 100 },
    });

    expect(result.decisions.some((item) => item.action.family === "tool")).toBe(true);
    expect(result.modelRoutingReceipts).toEqual([
      {
        schemaVersion: 1,
        routingDecisionId: "model-routing:selected",
        occurredAt: 100,
        outcome: "allowed",
        reasonCode: "model_route_selected",
        fallbackUsed: false,
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
      },
    ]);
    const json = JSON.stringify(result.modelRoutingReceipts);
    expect(json).not.toContain("summary");
    expect(json).not.toContain("contextId");
    expect(json).not.toContain("runId");
    expect(json).not.toContain("requestedProvider");
    expect(json).not.toContain("requestedModel");
    expect(json).not.toContain("unrelated-provider");
    expect(json).not.toContain("forged-provider");
  });

  it("bounds multiple routing receipts and marks fallback only from authoritative reason codes", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    recordExecutionDecisionFact(modelRoutingReceipt("model-routing:fallback", "rate_limit", 101), {
      ...database,
      now: 100,
    });
    recordExecutionDecisionFact(
      modelRoutingReceipt("model-routing:normal", "model_route_selected", 102),
      { ...database, now: 100 },
    );

    const result = presentExecutionDecisionReceipts({
      context,
      decisionLimit: 10,
      options: { ...database, now: 100 },
    });

    expect(result.modelRoutingReceipts).toEqual([
      {
        schemaVersion: 1,
        routingDecisionId: "model-routing:fallback",
        occurredAt: 101,
        outcome: "allowed",
        reasonCode: "rate_limit",
        fallbackUsed: true,
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
      },
      {
        schemaVersion: 1,
        routingDecisionId: "model-routing:normal",
        occurredAt: 102,
        outcome: "allowed",
        reasonCode: "model_route_selected",
        fallbackUsed: false,
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
      },
    ]);
  });

  it("derives fallbackUsed only from authoritative fallback reason codes", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    recordExecutionDecisionFact(
      modelRoutingReceipt(
        "model-routing:fallback-sentinel",
        "model_route_selected_after_fallback",
        101,
      ),
      { ...database, now: 100 },
    );
    recordExecutionDecisionFact(
      modelRoutingReceipt("model-routing:not-authorized-fallback", "fallback_like_reason", 102),
      { ...database, now: 100 },
    );

    const result = presentExecutionDecisionReceipts({
      context,
      decisionLimit: 10,
      options: { ...database, now: 100 },
    });

    expect(result.modelRoutingReceipts).toEqual([
      {
        schemaVersion: 1,
        routingDecisionId: "model-routing:fallback-sentinel",
        occurredAt: 101,
        outcome: "allowed",
        reasonCode: "model_route_selected_after_fallback",
        fallbackUsed: true,
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
      },
      {
        schemaVersion: 1,
        routingDecisionId: "model-routing:not-authorized-fallback",
        occurredAt: 102,
        outcome: "allowed",
        reasonCode: "fallback_like_reason",
        fallbackUsed: false,
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
      },
    ]);
  });

  it("persists authoritative model routing selection fields in receipt_json", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    recordExecutionDecisionFact(
      modelRoutingReceipt("model-routing:structured", "model_route_selected"),
      {
        ...database,
        now: 100,
      },
    );

    const page = pageExecutionDecisionFactsForContext({
      context: { contextId: "context-1", executionId: "execution-1", runId: "run-1" },
      limit: 1,
      now: 100,
      database,
    });
    expect(page.receipts[0]?.modelRouting).toEqual({
      selectedProvider: "openai",
      selectedModel: "gpt-5.6",
    });

    const result = presentExecutionDecisionReceipts({
      context,
      decisionCursor: "g:0:0",
      decisionLimit: 1,
      options: { ...database, now: 100 },
    });
    expect(result.modelRoutingReceipts).toEqual([
      {
        schemaVersion: 1,
        routingDecisionId: "model-routing:structured",
        occurredAt: 100,
        outcome: "allowed",
        reasonCode: "model_route_selected",
        fallbackUsed: false,
        selectedProvider: "openai",
        selectedModel: "gpt-5.6",
      },
    ]);
  });

  it("excludes non-authoritative and corrupt model-routing rows from the bounded projection", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    recordExecutionDecisionFact(
      {
        ...modelRoutingReceipt("model-routing:not-owner", "model_route_selected"),
        source: {
          owner: "other-owner",
          recordRef: "model-routing:not-owner",
          decisionBoundary: "agent-runtime.post-admission",
        },
      },
      { ...database, now: 100 },
    );
    recordExecutionDecisionFact(
      modelRoutingReceipt("model-routing:corrupt", "model_route_selected"),
      { ...database, now: 100 },
    );
    openOpenClawStateDatabase(database)
      .db.prepare("UPDATE execution_decision_facts SET receipt_json = ? WHERE receipt_id = ?")
      .run("{", "model-routing:corrupt");

    const result = presentExecutionDecisionReceipts({
      context,
      decisionCursor: "g:0:0",
      decisionLimit: 10,
      options: { ...database, now: 100 },
    });

    expect(result.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: expect.objectContaining({ family: "model-routing" }) }),
      ]),
    );
    expect(result.modelRoutingReceipts).toEqual([]);
  });

  it("keeps model routing receipts absent for non-routing audit runs", () => {
    const database = databaseOptions();
    const context = seedExecutionContext(database);
    recordExecutionDecisionFact(receipt("tool-policy"), { ...database, now: 100 });

    const result = presentExecutionDecisionReceipts({
      context,
      decisionLimit: 10,
      options: { ...database, now: 100 },
    });

    expect(result.modelRoutingReceipts).toEqual([]);
    expect(result.decisions.some((item) => item.action.family === "tool")).toBe(true);
  });
});
