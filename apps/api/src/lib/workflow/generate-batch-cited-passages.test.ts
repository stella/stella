import type { AnyTextAdapter } from "@tanstack/ai";
import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ScopedDb } from "@/api/db/safe-db";
import type { FieldContent } from "@/api/db/schema-validators";
import { toSafeId } from "@/api/lib/branded-types";
import type { ResolvedTanStackTextModel } from "@/api/lib/tanstack-ai-models";
import type { AnswerShape } from "@/api/lib/workflow/ai-answer-schema";
import { generateWorkflowData } from "@/api/lib/workflow/ai-generate-batch";
import { verifiedPassageTexts } from "@/api/lib/workflow/cited-passages";
import { generateBatch } from "@/api/lib/workflow/generate-batch";
import type { PreparedInputFile } from "@/api/lib/workflow/generate-batch";
import type { GenerateBatchProps } from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import { createScriptedTextAdapter } from "@/api/tests/helpers/chat-round-trip";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = toSafeId<"organization">("org_test");
const workspaceId = toSafeId<"workspace">("workspace_test");
const askId = toSafeId<"property">("ask");
const fileId = toSafeId<"property">("file");
const inputId = toSafeId<"property">("input");
const docxFieldId = toSafeId<"field">("field_docx");
const pdfFieldId = toSafeId<"field">("field_pdf");
const extractedFieldId = toSafeId<"field">("field_extracted");

const PASSAGE = "Payable within 30 days after receipt.";

const docxFile = {
  kind: "docx",
  fileFieldId: docxFieldId,
  fileId: "docx",
  simplifiedName: "F0",
  blocks: [
    {
      id: "b1",
      kind: "paragraph",
      statedNumbering: { kind: "inherit" },
      text: PASSAGE,
    },
  ],
} as const satisfies PreparedInputFile;

const pdfFile = {
  kind: "pdf",
  fileFieldId: pdfFieldId,
  fileId: "pdf",
  simplifiedName: "F1",
  content: new Uint8Array(),
  mimeType: "application/pdf",
  pageCount: 1,
} as const satisfies PreparedInputFile;

const extractedFile = {
  kind: "extracted-text",
  fileFieldId: extractedFieldId,
  fileId: "extracted",
  simplifiedName: "F2",
  content: "Late fee of 2% a month.",
} as const satisfies PreparedInputFile;

const fileField = {
  id: docxFieldId,
  propertyId: fileId,
  content: {
    version: 1,
    type: "file",
    id: "00000000-0000-4000-8000-000000000001",
    fileName: "contract.docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sizeBytes: 1024,
    encrypted: false,
    sha256Hex: "a".repeat(64),
    pdfFileId: null,
  },
} as const satisfies {
  id: unknown;
  propertyId: unknown;
  content: FieldContent;
};

const textInputField = (
  content: FieldContent,
): {
  id: ReturnType<typeof toSafeId<"field">>;
  propertyId: typeof inputId;
  content: FieldContent;
} => ({ id: toSafeId<"field">("field_input"), propertyId: inputId, content });

const DOCUMENT_TYPE_GATE = {
  type: "compare",
  left: { type: "property", propertyId: inputId },
  op: "eq",
  right: { type: "literal", value: "NDA" },
} as const;

const ask = (
  answerShape: AnswerShape,
  inputCondition: typeof DOCUMENT_TYPE_GATE | null,
): AIBatchProperty => ({
  id: askId,
  status: "stale",
  answerShape,
  content: { version: 1, type: "text" },
  dependencies: [
    { dependsOnPropertyId: fileId, condition: null },
    { dependsOnPropertyId: inputId, condition: inputCondition },
  ],
  tool: { version: 1, type: "ai-model", prompt: "What is the payment term?" },
});

const answeringModel: ResolvedTanStackTextModel = {
  adapter: {
    ...createScriptedTextAdapter([]),
    structuredOutput: async () => {
      const data = {
        [askId]: {
          answer: "Payable in 30 days",
          justification: [
            {
              file: "F0",
              statements: [{ text: "Payment term.", citations: ["b1"] }],
            },
          ],
        },
      };
      return { data, rawText: JSON.stringify(data) };
    },
  } satisfies AnyTextAdapter,
  keySource: "byok",
  modelId: "test-model",
  provider: "openai",
  modelOptions: {},
};

type GradedPassagesOptions = {
  property: AIBatchProperty;
  input: FieldContent;
  files: readonly PreparedInputFile[];
};

const gradedPassages = async ({
  property,
  input,
  files,
}: GradedPassagesOptions): Promise<string[]> => {
  const props = {
    abortSignal: new AbortController().signal,
    batch: { id: "batch", inputs: [fileId, inputId], properties: [property] },
    entityVersionId: toSafeId<"entityVersion">("entity_version"),
    organizationId,
    admission: testModelAdmission(organizationId),
    workspaceId,
    scopedDb: asTestRaw<ScopedDb>(async () => {
      throw new Error("unexpected database access");
    }),
    orgAIConfig: null,
    managedAIResidency: "eu" as const,
    promptCachingEnabled: false,
    serviceTier: "standard",
  } as const satisfies GenerateBatchProps;

  const { aiJustifications } = Result.unwrap(
    await generateBatch(props, {
      fetchInputFieldsForBatch: async () => [fileField, textInputField(input)],
      fetchAndPrepareFiles: async () => [...files],
      generateWorkflowData: async (options) =>
        await generateWorkflowData({
          ...options,
          decisionModel: null,
          resolveTextModel: async () => answeringModel,
        }),
    }),
  );
  const justification = aiJustifications.at(0);
  if (justification === undefined) {
    throw new Error("Expected the batch to save a justification");
  }
  return verifiedPassageTexts(justification.content);
};

describe("which saved answers are graded from their cited passages", () => {
  const documentType = {
    version: 1,
    type: "single-select",
    value: "NDA",
  } as const satisfies FieldContent;
  const pastedText = {
    version: 1,
    type: "text",
    value: "Late fee of 2% a month.",
  } as const satisfies FieldContent;

  test("a DOCX answer gated on the document type keeps its passages", async () => {
    expect(
      await gradedPassages({
        property: ask("clause-summary", DOCUMENT_TYPE_GATE),
        input: documentType,
        files: [docxFile],
      }),
    ).toEqual([PASSAGE]);
  });

  test("an answer that can quote pasted text is graded on the answer", async () => {
    expect(
      await gradedPassages({
        property: ask("clause-summary", null),
        input: pastedText,
        files: [docxFile],
      }),
    ).toEqual([]);
  });

  test.each([
    ["a PDF", pdfFile],
    ["extracted text", extractedFile],
  ] as const)(
    "an answer that can quote %s without citing it is graded on the answer",
    async (_label, otherFile) => {
      expect(
        await gradedPassages({
          property: ask("clause-summary", DOCUMENT_TYPE_GATE),
          input: documentType,
          files: [docxFile, otherFile],
        }),
      ).toEqual([]);
    },
  );

  test("a value answer is graded on the answer", async () => {
    expect(
      await gradedPassages({
        property: ask("value", DOCUMENT_TYPE_GATE),
        input: documentType,
        files: [docxFile],
      }),
    ).toEqual([]);
  });
});
