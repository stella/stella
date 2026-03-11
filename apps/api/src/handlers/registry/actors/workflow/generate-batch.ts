import { PDF, rgb, Standard14Font, StandardFonts } from "@libpdf/core";
import { matchError, Result } from "better-result";
import { nanoid } from "nanoid";

import { createFileKey } from "@/api/handlers/files/utils";
import { generateWorkflowData } from "@/api/handlers/registry/actors/workflow/ai-generate-batch";
import { validateAIOutput } from "@/api/handlers/registry/actors/workflow/ai-validators";
import {
  fetchInputFieldsForBatch,
  prepareBatchInput,
} from "@/api/handlers/registry/actors/workflow/generate-batch-shared";
import type {
  AIJustification,
  AIResult,
  GenerateBatchProps,
  GenerateBatchResult,
  ResolvedFile,
} from "@/api/handlers/registry/actors/workflow/generate-batch-shared";
import { parseJustificationXml } from "@/api/handlers/registry/actors/workflow/parse-justifications";
import type { JustificationFilenames } from "@/api/handlers/registry/actors/workflow/parse-justifications";
import type { SafeId } from "@/api/lib/branded-types";
import {
  Unreachable,
  WorkflowIntegrationError,
} from "@/api/lib/errors/tagged-errors";
import { s3 } from "@/api/lib/s3";
import { PDF_MIME_TYPE } from "@/api/mime-types";

/**
 * A file is AI-supported if it is a non-encrypted PDF, or
 * if it has a converted PDF (pdfFile) available.
 */
const isAISupportedFile = (file: ResolvedFile): boolean =>
  (file.mimeType === PDF_MIME_TYPE && !file.encrypted) ||
  file.pdfFileId !== null;

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

type FileWithContent = {
  fileFieldId: string;
  fileId: string;
  content: Uint8Array;
  mimeType: typeof PDF_MIME_TYPE;
  simplifiedName: string;
};

const fetchAndPrepareFiles = (
  resolvedFiles: ResolvedFile[],
  organizationId: SafeId<"organization">,
  workspaceId: SafeId<"workspace">,
): Promise<FileWithContent[]> =>
  Promise.all(
    resolvedFiles.map(async (meta, index) => {
      // Prefer the converted PDF; fall back to source if
      // the source is already a PDF.
      const pdfFileId = meta.pdfFileId ?? meta.fileId;

      const fileKey = createFileKey({
        organizationId,
        workspaceId,
        fileId: pdfFileId,
        mimeType: PDF_MIME_TYPE,
      });

      const simplifiedName = `F${index}`;
      const fileBuffer = await s3.file(fileKey).arrayBuffer();
      const preparedPdf = await addBatesNumbers(fileBuffer, simplifiedName);

      return {
        fileFieldId: meta.fileFieldId,
        fileId: meta.fileId,
        content: preparedPdf,
        mimeType: PDF_MIME_TYPE,
        simplifiedName,
      };
    }),
  );

export const generateBatch = ({
  abortSignal,
  batch,
  entityVersionId,
  organizationId,
  workspaceId,
  scopedDb,
}: GenerateBatchProps): Promise<GenerateBatchResult> =>
  Result.gen(async function* generateBatchGen() {
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

    const filenames: JustificationFilenames = preparedFiles.map((file) => ({
      original: file.fileId,
      simplified: file.simplifiedName,
      fileFieldId: file.fileFieldId,
    }));

    const output = yield* Result.await(
      generateWorkflowData({
        files: preparedFiles,
        properties: inputProperties,
        filenames,
        textInputs,
        abortSignal,
      }),
    );

    const aiResults: AIResult[] = [];
    const aiJustifications: AIJustification[] = [];

    for (const property of inputProperties) {
      const propertyResult = output[property.id];

      const validated = yield* validateAIOutput({
        aiResult: propertyResult,
        property,
      });

      const fieldId = nanoid();

      const justification = yield* parseJustificationXml({
        xml: validated.justificationXml,
        filenames,
      });

      if (justification) {
        const justificationId = nanoid();
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
  }).then((result) =>
    result.mapError((err) =>
      matchError(err, {
        ParseXmlError: (parseErr) =>
          new WorkflowIntegrationError({
            message: parseErr.message,
            cause: parseErr,
          }),
        WorkflowIntegrationError: (integrationErr) => integrationErr,
        WorkflowValidationError: (validErr) => validErr,
      }),
    ),
  );
