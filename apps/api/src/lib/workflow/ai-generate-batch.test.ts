import type { AnyTextAdapter } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import {
  DocumentTooLargeError,
  WorkflowIntegrationError,
} from "@/api/lib/errors/tagged-errors";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import {
  buildWorkflowAIAnalyticsProps,
  generateWorkflowData,
} from "@/api/lib/workflow/ai-generate-batch";
import { buildJustificationFilenames } from "@/api/lib/workflow/generate-batch";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import { requestBudgetBytesForTask } from "@/api/lib/workflow/request-budget";
import { createScriptedTextAdapter } from "@/api/tests/helpers/chat-round-trip";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";

const organizationId = toSafeId<"organization">("organization-1");
const userId = toSafeId<"user">("user-1");
const workspaceId = toSafeId<"workspace">("workspace-1");

describe("buildWorkflowAIAnalyticsProps", () => {
  test("threads workflow usage metering into AI analytics props", () => {
    const safeDb: SafeDb = async () => {
      throw new Error("safeDb should not be called by this test");
    };
    const usageMetering = {
      actionType: "background",
      organizationId,
      safeDb,
      serviceTier: "flex",
      userId,
      workspaceId,
    } satisfies AIUsageMetering;

    const props = buildWorkflowAIAnalyticsProps({
      entityVersionId: "entity-version-1",
      organizationId,
      orgAIConfig: null,
      propertyCount: 2,
      usageMetering,
      workspaceId,
    });

    expect(props).toMatchObject({
      feature: "workflow.generate-batch",
      modelTask: "pdf",
      properties: {
        entity_version_id: "entity-version-1",
        organization_id: organizationId,
        property_count: 2,
        workspace_id: workspaceId,
      },
      sessionId: "entity-version-1",
      usageMetering,
    });
  });
});

test("a fully planned workflow batch propagates a generative provider failure", async () => {
  const property = {
    id: toSafeId<"property">("planned-contract-kind"),
    status: "stale",
    content: {
      version: 1,
      type: "single-select",
      options: [{ value: "Purchase agreement", color: "gray" }],
      fallback: null,
    },
    dependencies: [],
    tool: {
      version: 1,
      type: "ai-model",
      prompt: "Which kind of contract is this?",
    },
  } satisfies AIBatchProperty;
  let providerCalls = 0;
  const adapter = {
    ...createScriptedTextAdapter([]),
    structuredOutput: async () => {
      providerCalls += 1;
      throw new Error("Synthetic workflow generative provider failure");
    },
  } satisfies AnyTextAdapter;
  const model = {
    adapter,
    keySource: "byok",
    modelId: "test-model",
    provider: "openai",
    modelOptions: {},
  } as const satisfies ResolvedTanStackTextModel;
  const result = await generateWorkflowData({
    files: [],
    properties: [property],
    filenames: [],
    textInputs: [
      {
        propertyId: property.id,
        value: "The agreement is a purchase agreement.",
      },
    ],
    linkedSkillsMessage: null,
    abortSignal: new AbortController().signal,
    entityVersionId: "entity-version-1",
    organizationId,
    workspaceId,
    admission: testModelAdmission(organizationId),
    orgAIConfig: null,
    managedAIResidency: "eu",
    promptCachingEnabled: false,
    serviceTier: "standard",
    decisionModel: null,
    resolveTextModel: async () => model,
  });
  expect(providerCalls).toBe(1);
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    throw new Error(
      "Expected a fully planned provider failure to fail the batch",
    );
  }
  expect(WorkflowIntegrationError.is(result.error)).toBe(true);
  expect(result.error.message).toBe(
    "Workflow typed decision could not be completed",
  );
  expect(result.error.cause).toMatchObject({
    propertyId: property.id,
    reason: "failed",
    source: "generative",
  });
});

describe("a request over its model's budget", () => {
  const property = {
    id: toSafeId<"property">("governing-law"),
    status: "stale",
    content: { version: 1, type: "text" },
    dependencies: [],
    tool: { version: 1, type: "ai-model", prompt: "Which law governs?" },
  } satisfies AIBatchProperty;

  const docxWithBlocks = (texts: readonly string[]): PreparedDocxFile => ({
    kind: "docx",
    fileFieldId: toSafeId<"field">("field-1"),
    fileId: "file-1",
    simplifiedName: "F0",
    blocks: texts.map((text, index) => ({
      id: `seq-${String(index)}`,
      kind: "paragraph",
      statedNumbering: { kind: "inherit" },
      text,
    })),
  });

  // The same budget generateWorkflowData resolves for this organization.
  const taskBudget = () =>
    requestBudgetBytesForTask("pdf", null, {
      dataClass: "customer",
      organizationId,
      modelTier: testModelAdmission(organizationId).modelTier,
    });

  const generate = async (
    file: PreparedDocxFile,
    textInputs: TextInput[] = [],
  ) => {
    const sentRequests: unknown[] = [];
    const record = (request: unknown) => {
      sentRequests.push(request);
      throw new Error("Synthetic provider failure");
    };
    const adapter = {
      ...createScriptedTextAdapter([]),
      chatStream: record,
      structuredOutput: record,
    } satisfies AnyTextAdapter;
    const result = await generateWorkflowData({
      files: [file],
      properties: [property],
      filenames: buildJustificationFilenames([file]),
      textInputs,
      linkedSkillsMessage: null,
      abortSignal: new AbortController().signal,
      entityVersionId: "entity-version-1",
      organizationId,
      workspaceId,
      admission: testModelAdmission(organizationId),
      orgAIConfig: null,
      managedAIResidency: "eu",
      promptCachingEnabled: false,
      serviceTier: "standard",
      decisionModel: null,
      resolveTextModel: async () => ({
        adapter,
        keySource: "byok",
        modelId: "test-model",
        provider: "openai",
        modelOptions: {},
      }),
    });
    return { result, sentRequests };
  };

  test("sends the model a cut document, within the budget", async () => {
    const budget = taskBudget();
    const file = docxWithBlocks(["c".repeat(budget + 50_000)]);

    const { sentRequests } = await generate(file);
    const sent = JSON.stringify(sentRequests.at(0));

    expect(sent).toContain("c[… text withheld …]c");
    expect(sent).toContain("seq-0");
    expect(sent).not.toContain("c".repeat(budget));
  });

  test("leaves room for the answers of earlier columns", async () => {
    const text = "c".repeat(taskBudget() - 1000);
    const file = docxWithBlocks([text]);
    const textInputs = [{ propertyId: property.id, value: "a".repeat(10_000) }];

    const whole = await generate(file);
    const beside = await generate(file, textInputs);

    expect(JSON.stringify(whole.sentRequests.at(0))).toContain(text);
    expect(JSON.stringify(beside.sentRequests.at(0))).not.toContain(text);
  });

  test("refuses with a typed error, with no model call", async () => {
    const budget = taskBudget();
    const file = docxWithBlocks(["c".repeat(budget * 3)]);

    const { result, sentRequests } = await generate(file);

    expect(sentRequests).toEqual([]);
    expect(result.isErr() && DocumentTooLargeError.is(result.error)).toBe(true);
  });
});
