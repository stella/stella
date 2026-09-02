import { PDF, rgb, Standard14Font, StandardFonts } from "@libpdf/core";
import { Result } from "better-result";

import { FolioDocxReviewer, type FolioAIBlock } from "@stll/folio-core/server";

import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { WorkflowIntegrationError } from "@/api/lib/errors/tagged-errors";
import { createFileKey } from "@/api/lib/files/utils";
import { readS3ArrayBuffer } from "@/api/lib/s3";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import {
  canPrepareExtractedTextFile,
  isAISupportedFile,
} from "@/api/lib/workflow/ai-file-support";
import { generateWorkflowData } from "@/api/lib/workflow/ai-generate-batch";
import {
  fieldContentFromValidated,
  validateAIOutput,
} from "@/api/lib/workflow/ai-validators";
import {
  fetchInputFieldsForBatch,
  prepareBatchInput,
} from "@/api/lib/workflow/generate-batch-shared";
import type {
  AIJustification,
  AIResult,
  GenerateBatchProps,
  GenerateBatchResult,
  ResolvedFile,
} from "@/api/lib/workflow/generate-batch-shared";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";
import type { JustificationFilenames } from "@/api/lib/workflow/parse-justifications";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

/**
 * A file is AI-supported when it can be sent to the model in some
 * form: a non-encrypted PDF, a file that's already been converted
 * to PDF (`pdfFileId`), a DOCX whose folio blocks we serialise, or a
 * natively rendered Office file whose anydoc text we serialise.
 */
// Exported (with `fetchAndPrepareFiles` / `buildJustificationFilenames` below)
// so the single-doc ephemeral review (`lib/document-review/review-extract.ts`)
// reuses the exact same file-preparation + citation-allow-list wiring the batch
// workflow uses, instead of forking a parallel DOCX→blocks / PDF→bates path.
export { isAISupportedFile };

export type GenerateBatchDependencies = {
  fetchInputFieldsForBatch: typeof fetchInputFieldsForBatch;
};

const defaultGenerateBatchDependencies = {
  fetchInputFieldsForBatch,
} satisfies GenerateBatchDependencies;

const addBatesNumbers = async (
  pdfBuffer: ArrayBuffer,
  simplifiedName: string,
): Promise<{ content: Uint8Array; pageCount: number }> => {
  const pdfDocument = await PDF.load(new Uint8Array(pdfBuffer));
  const font = Standard14Font.of(StandardFonts.Helvetica);
  const pages = pdfDocument.getPages();
  const fontSize = 10;
  const padding = 4;

  for (const page of pages) {
    const { width, height, index } = page;
    const batesNumber = `${simplifiedName}-${String(index + 1).padStart(4, "0")}`;
    const textWidth = font.widthOfTextAtSize(batesNumber, fontSize);
    const textHeight = font.heightAtSize(fontSize);
    const rectangleWidth = textWidth + padding * 2;
    const rectangleHeight = textHeight + padding * 2;

    const positions = [
      { x: 0, y: height - rectangleHeight }, // Top-left
      { x: width - rectangleWidth, y: height - rectangleHeight }, // Top-right
      { x: 0, y: 0 }, // Bottom-left
      { x: width - rectangleWidth, y: 0 }, // Bottom-right
    ];

    for (const pos of positions) {
      page.drawRectangle({
        x: pos.x,
        y: pos.y,
        width: rectangleWidth,
        height: rectangleHeight,
        color: rgb(0, 0, 0),
      });

      page.drawText(batesNumber, {
        x: pos.x + padding,
        y: pos.y + padding,
        size: fontSize,
        color: rgb(1, 1, 1),
      });
    }
  }

  return {
    content: await pdfDocument.save(),
    pageCount: pages.length,
  };
};

export type PreparedPdfFile = {
  kind: "pdf";
  fileFieldId: SafeId<"field">;
  fileId: string;
  content: Uint8Array;
  pageCount: number;
  mimeType: typeof PDF_MIME_TYPE;
  simplifiedName: string;
};

export type PreparedDocxFile = {
  kind: "docx";
  fileFieldId: SafeId<"field">;
  fileId: string;
  blocks: FolioAIBlock[];
  simplifiedName: string;
};

export type PreparedExtractedTextFile = {
  kind: "extracted-text";
  fileFieldId: SafeId<"field">;
  fileId: string;
  content: string;
  simplifiedName: string;
};

export type PreparedInputFile =
  | PreparedPdfFile
  | PreparedDocxFile
  | PreparedExtractedTextFile;

export const fetchAndPrepareFiles = async (
  resolvedFiles: ResolvedFile[],
  organizationId: SafeId<"organization">,
  workspaceId: SafeId<"workspace">,
): Promise<PreparedInputFile[]> =>
  await Promise.all(
    resolvedFiles.map(async (meta, index): Promise<PreparedInputFile> => {
      const simplifiedName = `F${index}`;

      // DOCX without a converted PDF: parse to folio blocks and let
      // the AI cite block IDs directly. Falling through to the PDF
      // path when `pdfFileId` exists keeps existing converted-DOCX
      // matters on the bates-citation flow they're already indexed
      // against.
      if (meta.mimeType === DOCX_MIME_TYPE && meta.pdfFileId === null) {
        const fileKey = createFileKey({
          organizationId,
          workspaceId,
          fileId: meta.fileId,
          mimeType: DOCX_MIME_TYPE,
        });
        const docxBuffer = await readS3ArrayBuffer(fileKey);
        const reviewer = await FolioDocxReviewer.fromBuffer(docxBuffer);
        const blocks = reviewer.getContent();
        return {
          kind: "docx",
          fileFieldId: meta.fileFieldId,
          fileId: meta.fileId,
          blocks,
          simplifiedName,
        };
      }

      if (canPrepareExtractedTextFile(meta)) {
        const fileKey = createFileKey({
          organizationId,
          workspaceId,
          fileId: meta.fileId,
          mimeType: meta.mimeType,
        });
        const fileBuffer = await readS3ArrayBuffer(fileKey);
        const extracted = await extractFileTextResult(
          fileBuffer,
          meta.mimeType,
        );
        if (Result.isError(extracted)) {
          throw new WorkflowIntegrationError({
            message: "Failed to extract native Office file for AI review",
            cause: extracted.error,
          });
        }
        return {
          kind: "extracted-text",
          fileFieldId: meta.fileFieldId,
          fileId: meta.fileId,
          content: extracted.value ?? "",
          simplifiedName,
        };
      }

      // PDF or PDF-converted file. Prefer the converted PDF; fall
      // back to source if the source is already a PDF.
      const pdfFileId = meta.pdfFileId ?? meta.fileId;
      const fileKey = createFileKey({
        organizationId,
        workspaceId,
        fileId: pdfFileId,
        mimeType: PDF_MIME_TYPE,
      });
      const fileBuffer = await readS3ArrayBuffer(fileKey);
      const preparedPdf = await addBatesNumbers(fileBuffer, simplifiedName);
      return {
        kind: "pdf",
        fileFieldId: meta.fileFieldId,
        fileId: meta.fileId,
        content: preparedPdf.content,
        pageCount: preparedPdf.pageCount,
        mimeType: PDF_MIME_TYPE,
        simplifiedName,
      };
    }),
  );

export const buildJustificationFilenames = (
  files: PreparedInputFile[],
): JustificationFilenames => {
  const filenames: JustificationFilenames = [];
  for (const file of files) {
    if (file.kind === "pdf") {
      filenames.push({
        kind: "pdf-bates",
        original: file.fileId,
        simplified: file.simplifiedName,
        fileFieldId: file.fileFieldId,
      });
      continue;
    }
    if (file.kind === "extracted-text") {
      continue;
    }
    filenames.push({
      kind: "docx-folio",
      original: file.fileId,
      simplified: file.simplifiedName,
      fileFieldId: file.fileFieldId,
      blocksById: new Map(file.blocks.map((block) => [block.id, block.text])),
    });
  }
  return filenames;
};

export const generateBatch = async (
  {
    abortSignal,
    batch,
    entityVersionId,
    organizationId,
    workspaceId,
    scopedDb,
    orgAIConfig,
    promptCachingEnabled,
    serviceTier,
    usageMetering,
    onPartialAnswer,
  }: GenerateBatchProps,
  dependencies: GenerateBatchDependencies = defaultGenerateBatchDependencies,
): Promise<GenerateBatchResult> =>
  await Result.gen(async function* () {
    const inputFields = await dependencies.fetchInputFieldsForBatch({
      entityVersionId,
      inputPropertyIds: batch.inputs,
      scopedDb,
    });
    const { inputProperties, resolvedFiles, textInputs, skippedPropertyIds } =
      yield* prepareBatchInput(inputFields, batch);

    // The LLM extraction path only handles ai-model columns; verdict columns
    // in the same level are graded by the verdict engine (dispatched upstream
    // in `processOneBatch`), so they never reach here.
    const aiInputProperties = inputProperties.filter(
      (property): property is AIBatchProperty =>
        property.tool.type === "ai-model",
    );

    if (aiInputProperties.length === 0) {
      return Result.ok({
        aiResults: [],
        aiJustifications: [],
        skippedPropertyIds,
        unsupportedPropertyIds: [],
      });
    }

    const hasUnsupportedFiles = resolvedFiles.some(
      (f) => !isAISupportedFile(f),
    );

    if (hasUnsupportedFiles) {
      return Result.ok({
        aiResults: [],
        aiJustifications: [],
        skippedPropertyIds,
        unsupportedPropertyIds: aiInputProperties.map((p) => p.id),
      });
    }

    // `fetchAndPrepareFiles` signals failure by rejecting (S3 reads, DOCX
    // parsing, bates stamping, text extraction). Awaiting it bare would let
    // that rejection escape `Result.gen` as a panic, so the integration
    // failure this function declares in its error union would never reach
    // the caller's retry and status classification.
    const preparedFiles = yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await fetchAndPrepareFiles(
            resolvedFiles,
            organizationId,
            workspaceId,
          ),
        catch: (cause) =>
          new WorkflowIntegrationError({
            message: "Failed to prepare workflow input files",
            cause,
          }),
      }),
    );

    const filenames = buildJustificationFilenames(preparedFiles);

    const output = yield* Result.await(
      generateWorkflowData({
        entityVersionId,
        files: preparedFiles,
        properties: aiInputProperties,
        filenames,
        textInputs,
        abortSignal,
        organizationId,
        orgAIConfig: orgAIConfig ?? null,
        promptCachingEnabled,
        serviceTier,
        usageMetering,
        onPartialAnswer,
        workspaceId,
      }),
    );

    const aiResults: AIResult[] = [];
    const aiJustifications: AIJustification[] = [];

    for (const property of aiInputProperties) {
      const propertyResult = output[property.id];
      if (!propertyResult) {
        continue;
      }

      const validated = yield* validateAIOutput({
        aiResult: propertyResult,
        property,
      });

      const content = fieldContentFromValidated(validated);
      if (content === null) {
        // The model reported no value for this text/int property. Leave the
        // cell unwritten rather than persist a fabricated placeholder.
        continue;
      }

      const fieldId = createSafeId<"field">();

      const justification = yield* normalizeJustification({
        justification: validated.justification,
        filenames,
      });

      if (justification) {
        const justificationId = createSafeId<"justification">();
        aiJustifications.push({
          fieldId,
          justificationId,
          ...justification,
        });
      }

      aiResults.push({
        fieldId,
        propertyId: property.id,
        content,
      });
    }

    return Result.ok({
      aiResults,
      aiJustifications,
      skippedPropertyIds,
      unsupportedPropertyIds: [],
    });
  });
