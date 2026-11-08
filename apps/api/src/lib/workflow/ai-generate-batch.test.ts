import type { AnyTextAdapter } from "@tanstack/ai";
import { describe, expect, spyOn, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AIUsageMetering } from "@/api/lib/analytics/tanstack-ai";
import { toSafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import type { AnswerShape } from "@/api/lib/workflow/ai-answer-schema";
import {
  buildWorkflowAIAnalyticsProps,
  EXTRACTED_TEXT_PROMPT_LIMITS,
  generateWorkflowData,
  limitExtractedTextPromptContent,
  resolveClauseAnswerShapes,
} from "@/api/lib/workflow/ai-generate-batch";
import {
  PROMPT_INPUT_TRUNCATED_EVENT,
  PROMPT_TRUNCATION_MARKER,
} from "@/api/lib/workflow/ai-prompts";
import type {
  PreparedDocxFile,
  PreparedInputFile,
} from "@/api/lib/workflow/generate-batch";
import type { TextInput } from "@/api/lib/workflow/generate-batch-shared";
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

  test("records each cut file and the characters it dropped", () => {
    const logInfo = spyOn(logger, "info").mockImplementation(() => {});
    try {
      limitExtractedTextPromptContent({ content: "short", fileCount: 1 });
      expect(logInfo).not.toHaveBeenCalled();

      const content = "a".repeat(EXTRACTED_TEXT_PROMPT_LIMITS.perFileChars + 5);
      limitExtractedTextPromptContent({ content, fileCount: 1 });

      expect(logInfo).toHaveBeenCalledWith(PROMPT_INPUT_TRUNCATED_EVENT, {
        input: "extracted_text",
        truncated_parts: "1",
        dropped_chars: String(
          content.length -
            (EXTRACTED_TEXT_PROMPT_LIMITS.perFileChars -
              PROMPT_TRUNCATION_MARKER.length),
        ),
        max_chars: String(EXTRACTED_TEXT_PROMPT_LIMITS.perFileChars),
      });
    } finally {
      logInfo.mockRestore();
    }
  });
});

test("a fully planned workflow batch propagates a generative provider failure", async () => {
  const property = {
    id: toSafeId<"property">("planned-contract-kind"),
    status: "stale",
    answerShape: "value",
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

describe("resolveClauseAnswerShapes", () => {
  const property = (answerShape: AnswerShape): AIBatchProperty => ({
    id: toSafeId<"property">(answerShape),
    status: "stale",
    answerShape,
    content: { version: 1, type: "text" },
    dependencies: [],
    tool: { version: 1, type: "ai-model", prompt: "Question?" },
  });
  const docx = {
    kind: "docx",
    fileFieldId: toSafeId<"field">("docx_field"),
    fileId: "docx",
    simplifiedName: "F0",
    blocks: [],
  } as const satisfies PreparedDocxFile;
  const pdf = {
    kind: "pdf",
    fileFieldId: toSafeId<"field">("pdf_field"),
    fileId: "pdf",
    simplifiedName: "F1",
    content: new Uint8Array(),
    mimeType: "application/pdf",
    pageCount: 1,
  } as const satisfies PreparedInputFile;
  const extracted = {
    kind: "extracted-text",
    fileFieldId: toSafeId<"field">("text_field"),
    fileId: "text",
    simplifiedName: "F2",
    content: "Text.",
  } as const satisfies PreparedInputFile;
  const textInput = {
    propertyId: toSafeId<"property">("input"),
    value: "A value.",
  };

  const shapeFor = (
    files: readonly PreparedInputFile[],
    textInputs: readonly TextInput[] = [],
  ) =>
    resolveClauseAnswerShapes([property("clause-summary")], {
      files,
      textInputs,
    }).at(0)?.answerShape;

  test("only a batch of DOCX blocks answers with a summary", () => {
    expect(shapeFor([docx])).toBe("clause-summary");
    expect(shapeFor([pdf])).toBe("clause-quote");
    expect(shapeFor([extracted])).toBe("clause-quote");
  });

  test("one source without blocks makes the whole batch quote", () => {
    expect(shapeFor([docx, pdf])).toBe("clause-quote");
    expect(shapeFor([docx, extracted])).toBe("clause-quote");
    expect(shapeFor([docx], [textInput])).toBe("clause-quote");
  });

  test("a value that only gates the column is not a source", () => {
    const gated = {
      ...property("clause-summary"),
      dependencies: [
        {
          dependsOnPropertyId: textInput.propertyId,
          condition: {
            type: "compare",
            left: { type: "property", propertyId: textInput.propertyId },
            op: "eq",
            right: { type: "literal", value: "A value." },
          },
        },
      ],
    } as const satisfies AIBatchProperty;
    const gatedShape = (files: readonly PreparedInputFile[]) =>
      resolveClauseAnswerShapes([gated], {
        files,
        textInputs: [textInput],
      }).at(0)?.answerShape;

    expect(gatedShape([docx])).toBe("clause-summary");
    expect(gatedShape([docx, pdf])).toBe("clause-quote");
  });

  test("a value answer is the same whatever the sources", () => {
    expect(
      resolveClauseAnswerShapes([property("value")], {
        files: [pdf],
        textInputs: [],
      }).at(0)?.answerShape,
    ).toBe("value");
  });
});
