import type { AnyTextAdapter } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import {
  buildWorkflowAIAnalyticsProps,
  EXTRACTED_TEXT_PROMPT_LIMITS,
  generateWorkflowData,
  limitExtractedTextPromptContent,
} from "@/api/lib/workflow/ai-generate-batch";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
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

describe("extracted-text prompt limits", () => {
  test("enforces per-file and aggregate bounds with visible truncation", () => {
    const contents = [
      "a".repeat(80_000),
      "b".repeat(80_000),
      "c".repeat(80_000),
    ];
    const limited = contents.map((content) =>
      limitExtractedTextPromptContent({
        content,
        fileCount: contents.length,
      }),
    );

    expect(
      limited.every(
        (content) =>
          content.length <= EXTRACTED_TEXT_PROMPT_LIMITS.perFileChars,
      ),
    ).toBe(true);
    expect(
      limited.reduce((total, content) => total + content.length, 0),
    ).toBeLessThanOrEqual(EXTRACTED_TEXT_PROMPT_LIMITS.totalChars);
    expect(limited.every((content) => content.includes("truncated"))).toBe(
      true,
    );
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
