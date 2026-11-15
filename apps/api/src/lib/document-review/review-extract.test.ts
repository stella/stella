import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import {
  collectReviewCitations,
  extractAskContents,
  keepNavigableReviewCitations,
} from "@/api/lib/document-review/review-extract";
import type {
  ExtractAskContentsArgs,
  ReviewAsk,
} from "@/api/lib/document-review/review-extract";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { brandDerivedPropertyId } from "@/api/lib/safe-id-boundaries";
import type { WorkflowDataOutput } from "@/api/lib/workflow/ai-generate-batch";
import type { PreparedInputFile } from "@/api/lib/workflow/generate-batch";
import type { ResolvedFile } from "@/api/lib/workflow/generate-batch-shared";
import type {
  AIJustificationOutput,
  JustificationFilenames,
} from "@/api/lib/workflow/parse-justifications";
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";

const field = (id: string): SafeId<"field"> => toSafeId<"field">(id);

describe("review extraction citations", () => {
  test("keeps trusted PDF locators and verified DOCX anchors with ownership", () => {
    const filenames: JustificationFilenames = [
      {
        kind: "pdf-bates",
        original: "Contract.pdf",
        simplified: "contract",
        fileFieldId: field("f-pdf"),
      },
      {
        kind: "docx-folio",
        original: "Brief.docx",
        simplified: "brief",
        fileFieldId: field("f-docx"),
        blocksById: new Map([["AAAA0001", "The verified paragraph."]]),
      },
    ];
    const justification: AIJustificationOutput = [
      {
        file: "contract",
        statements: [{ text: "payment", citations: ["contract-7"] }],
      },
      {
        file: "brief",
        statements: [
          {
            text: "breach",
            citations: ["AAAA0001", "unverified prose quote"],
          },
        ],
      },
    ];

    const normalized = normalizeJustification({ justification, filenames });
    const parsed = normalized.unwrap();
    expect(parsed).not.toBeNull();
    if (parsed === null) {
      throw new Error("expected a normalized justification");
    }

    expect(collectReviewCitations(parsed.content)).toEqual([
      {
        kind: "pdf-bates",
        fileFieldId: field("f-pdf"),
        bates: "contract-7",
        pageNumber: 7,
        statement: "payment",
      },
      {
        kind: "docx-folio",
        fileFieldId: field("f-docx"),
        blockId: "AAAA0001",
        text: "The verified paragraph.",
        statement: "breach",
      },
    ]);
  });

  test("keeps statement associations while omitting unverified hints", () => {
    expect(
      collectReviewCitations({
        version: 1,
        blocks: [
          {
            kind: "docx-folio",
            fileFieldId: field("f-docx"),
            statements: [
              {
                text: "claim one",
                citations: [
                  {
                    citationStatus: "verified",
                    blockId: "AAAA0001",
                    text: "Paragraph",
                  },
                  {
                    citationStatus: "verified",
                    blockId: "AAAA0001",
                    text: "Paragraph",
                  },
                  {
                    citationStatus: "unverified",
                    text: "model hint",
                  },
                ],
              },
              {
                text: "claim two",
                citations: [
                  {
                    citationStatus: "verified",
                    blockId: "AAAA0001",
                    text: "Paragraph",
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        kind: "docx-folio",
        fileFieldId: field("f-docx"),
        blockId: "AAAA0001",
        text: "Paragraph",
        statement: "claim one",
      },
      {
        kind: "docx-folio",
        fileFieldId: field("f-docx"),
        blockId: "AAAA0001",
        text: "Paragraph",
        statement: "claim two",
      },
    ]);
  });

  test("rejects PDF locators beyond the prepared file page count", () => {
    expect(
      keepNavigableReviewCitations(
        [
          {
            kind: "pdf-bates",
            fileFieldId: field("f-pdf"),
            bates: "F0-0002",
            pageNumber: 2,
            statement: "inside",
          },
          {
            kind: "pdf-bates",
            fileFieldId: field("f-pdf"),
            bates: "F0-9999",
            pageNumber: 9999,
            statement: "outside",
          },
        ],
        [
          {
            kind: "pdf",
            fileFieldId: field("f-pdf"),
            fileId: "pdf-file",
            content: new Uint8Array(),
            mimeType: "application/pdf",
            pageCount: 2,
            simplifiedName: "F0",
          },
        ],
      ),
    ).toEqual([
      {
        kind: "pdf-bates",
        fileFieldId: field("f-pdf"),
        bates: "F0-0002",
        pageNumber: 2,
        statement: "inside",
      },
    ]);
  });
});

describe("review extraction outcomes", () => {
  const ORGANIZATION_ID = toSafeId<"organization">(
    "11111111-1111-4111-8111-111111111111",
  );
  const SOURCE_ID = "55555555-5555-4555-8555-000000000001";
  const ask: ReviewAsk = {
    sourceId: SOURCE_ID,
    question: "What is the notice period?",
    content: { version: 1, type: "text" },
    answerShape: "value",
  };
  const docx: ResolvedFile = {
    fileFieldId: field("field_docx"),
    fileId: "file-docx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    sha256Hex: "a".repeat(64),
    encrypted: false,
    pdfFileId: null,
  };
  const preparedDocx: PreparedInputFile = {
    kind: "docx",
    fileFieldId: docx.fileFieldId,
    fileId: docx.fileId,
    simplifiedName: "F0",
    blocks: [
      {
        kind: "paragraph",
        statedNumbering: { kind: "inherit" },
        id: "paragraph-1",
        text: "Thirty days' written notice.",
      },
    ],
  };

  const extract = async (
    resolvedFiles: ResolvedFile[],
    output: WorkflowDataOutput,
  ) =>
    await extractAskContents({
      asks: [ask],
      resolvedFiles,
      abortSignal: new AbortController().signal,
      organizationId: ORGANIZATION_ID,
      admission: testModelAdmission(ORGANIZATION_ID),
      workspaceId: toSafeId<"workspace">(
        "22222222-2222-4222-8222-222222222222",
      ),
      entityVersionId: toSafeId<"entityVersion">(
        "33333333-3333-4333-8333-333333333333",
      ),
      orgAIConfig: null,
      managedAIResidency: "eu",
      promptCachingEnabled: false,
      serviceTier: "standard",
      fetchAndPrepareFiles: async () => [preparedDocx],
      generateWorkflowData: (async ({ properties }) =>
        await Promise.resolve(
          Result.ok({
            output,
            refusedPropertyIds: new Set(),
            properties,
            fit: { type: "whole", files: [preparedDocx] },
          }),
        )) satisfies ExtractAskContentsArgs["generateWorkflowData"],
    });

  // Derived from the ask, exactly as extraction names it in the request.
  const propertyId = brandDerivedPropertyId(SOURCE_ID);

  test("a value the model answered is kept with its outcome", async () => {
    const result = Result.unwrap(
      await extract([docx], {
        [propertyId]: { answer: "Thirty days", justification: [] },
      }),
    );

    expect(result.outcomeBySourceId.get(SOURCE_ID)).toEqual({
      type: "answered",
      content: { version: 1, type: "text", value: "Thirty days" },
      citations: [],
    });
  });

  test("a null answer is a stated absence, not a failure", async () => {
    const result = Result.unwrap(
      await extract([docx], {
        [propertyId]: { answer: null, justification: [] },
      }),
    );

    expect(result.outcomeBySourceId.get(SOURCE_ID)).toEqual({
      type: "not-stated",
    });
  });

  test("an answer the request never returned fails extraction rather than reading as absent", async () => {
    const result = await extract([docx], {});

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(WorkflowIntegrationError.is(result.error)).toBe(true);
    }
  });

  test("asks with no file the model can read fail extraction rather than reading as absent", async () => {
    const result = await extract([{ ...docx, encrypted: true }], {});

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(WorkflowIntegrationError.is(result.error)).toBe(true);
    }
  });
});
