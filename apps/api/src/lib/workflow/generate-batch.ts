import { PDF, rgb, Standard14Font, StandardFonts } from "@libpdf/core";
import { Result } from "better-result";

import type { FolioAIBlock } from "@stll/folio/server";

import { createFileKey } from "@/api/handlers/files/utils";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { Unreachable } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { generateWorkflowData } from "@/api/lib/workflow/ai-generate-batch";
import { validateAIOutput } from "@/api/lib/workflow/ai-validators";
import { extractFolioBlocksFromDocxBuffer } from "@/api/lib/workflow/docx-blocks";
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
import { normalizeJustification } from "@/api/lib/workflow/parse-justifications";
import type { JustificationFilenames } from "@/api/lib/workflow/parse-justifications";
import { DOCX_MIME_TYPE, PDF_MIME_TYPE } from "@/api/mime-types";

/**
 * A file is AI-supported when it can be sent to the model in some
 * form: a non-encrypted PDF, a file that's already been converted
 * to PDF (`pdfFileId`), or a DOCX whose folio blocks we serialise
 * into the prompt directly.
 */
const isAISupportedFile = (file: ResolvedFile): boolean =>
  (file.mimeType === PDF_MIME_TYPE && !file.encrypted) ||
  file.pdfFileId !== null ||
  file.mimeType === DOCX_MIME_TYPE;

const addBatesNumbers = async (
  pdfBuffer: ArrayBuffer,
  simplifiedName: string,
): Promise<Uint8Array> => {
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

  return await pdfDocument.save();
};

export type PreparedPdfFile = {
  kind: "pdf";
  fileFieldId: SafeId<"field">;
  fileId: string;
  content: Uint8Array;
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

export type PreparedInputFile = PreparedPdfFile | PreparedDocxFile;

const fetchAndPrepareFiles = async (
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
        const docxBuffer = await getS3().file(fileKey).arrayBuffer();
        const blocks = await extractFolioBlocksFromDocxBuffer(docxBuffer);
        return {
          kind: "docx",
          fileFieldId: meta.fileFieldId,
          fileId: meta.fileId,
          blocks,
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
      const fileBuffer = await getS3().file(fileKey).arrayBuffer();
      const preparedPdf = await addBatesNumbers(fileBuffer, simplifiedName);
      return {
        kind: "pdf",
        fileFieldId: meta.fileFieldId,
        fileId: meta.fileId,
        content: preparedPdf,
        mimeType: PDF_MIME_TYPE,
        simplifiedName,
      };
    }),
  );

const buildJustificationFilenames = (
  files: PreparedInputFile[],
): JustificationFilenames =>
  files.map((file) => {
    if (file.kind === "pdf") {
      return {
        kind: "pdf-bates",
        original: file.fileId,
        simplified: file.simplifiedName,
        fileFieldId: file.fileFieldId,
      };
    }
    return {
      kind: "docx-folio",
      original: file.fileId,
      simplified: file.simplifiedName,
      fileFieldId: file.fileFieldId,
      blocksById: new Map(file.blocks.map((block) => [block.id, block.text])),
    };
  });

export const generateBatch = async ({
  abortSignal,
  batch,
  entityVersionId,
  organizationId,
  workspaceId,
  scopedDb,
  orgAIConfig,
  promptCachingEnabled,
  serviceTier,
  onPartialAnswer,
}: GenerateBatchProps): Promise<GenerateBatchResult> =>
  await Result.gen(async function* () {
    const inputFields = await fetchInputFieldsForBatch({
      entityVersionId,
      inputPropertyIds: batch.inputs,
      scopedDb,
    });
    const { inputProperties, resolvedFiles, textInputs, skippedPropertyIds } =
      yield* prepareBatchInput(inputFields, batch);

    if (inputProperties.length === 0) {
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
        unsupportedPropertyIds: inputProperties.map((p) => p.id),
      });
    }

    const preparedFiles = await fetchAndPrepareFiles(
      resolvedFiles,
      organizationId,
      workspaceId,
    );

    const filenames = buildJustificationFilenames(preparedFiles);

    const output = yield* Result.await(
      generateWorkflowData({
        entityVersionId,
        files: preparedFiles,
        properties: inputProperties,
        filenames,
        textInputs,
        abortSignal,
        organizationId,
        orgAIConfig: orgAIConfig ?? null,
        promptCachingEnabled,
        serviceTier,
        onPartialAnswer,
        workspaceId,
      }),
    );

    const aiResults: AIResult[] = [];
    const aiJustifications: AIJustification[] = [];

    for (const property of inputProperties) {
      const propertyResult = output[property.id];
      if (!propertyResult) {
        continue;
      }

      const validated = yield* validateAIOutput({
        aiResult: propertyResult,
        property,
      });

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

      switch (validated.type) {
        case "text": {
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "text",
              version: 1,
              value: validated.value,
            },
          });
          break;
        }
        case "single-select": {
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "single-select",
              version: 1,
              value: validated.value,
            },
          });
          break;
        }
        case "multi-select": {
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "multi-select",
              version: 1,
              value: validated.value,
            },
          });
          break;
        }
        case "date": {
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "date",
              version: 1,
              value: validated.value,
            },
          });
          break;
        }
        case "int": {
          aiResults.push({
            fieldId,
            propertyId: property.id,
            content: {
              type: "int",
              version: 1,
              value: validated.value,
              currency: validated.currency,
            },
          });
          break;
        }
        default:
          throw new Unreachable({
            message: "Property type not matched",
          });
      }
    }

    return Result.ok({
      aiResults,
      aiJustifications,
      skippedPropertyIds,
      unsupportedPropertyIds: [],
    });
  });
