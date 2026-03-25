import { PDF } from "@libpdf/core";
import { Result, TaggedError } from "better-result";
import * as slimdom from "slimdom";

import type { ScopedDb } from "@/api/db";
import type { FieldContent } from "@/api/db/schema-validators";
import { createFileKey } from "@/api/handlers/files/utils";
import type { SafeId } from "@/api/lib/branded-types";
import { ParseXmlError } from "@/api/lib/errors/tagged-errors";
import { s3 } from "@/api/lib/s3";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import type { BoundingBox } from "@/api/types";

export type GenerateBBoxesProps = {
  abortSignal: AbortSignal;
  data: {
    prompt: string;
    fieldContent: string;
    justificationText: string;
    pdf: PDF;
    pageNumber: number;
  };
};

export type GenerateBBoxesResult = BoundingBox[];

class JustificationTextError extends TaggedError("JustificationTextError")<{
  message: string;
}>() {}

export const parseJustificationContent = (justification: string) => {
  const pageNumbers = new Set<number>();

  const documentResult = Result.try({
    try: () => slimdom.parseXmlDocument(`<root>${justification}</root>`),
    catch: (error) =>
      new ParseXmlError({
        message: "Failed to parse justification XML",
        cause: error,
      }),
  });

  if (Result.isError(documentResult)) {
    return Result.err(documentResult.error);
  }

  const document = documentResult.value;
  // eslint-disable-next-line unicorn/prefer-query-selector -- slimdom XML document does not support querySelectorAll
  const spans = document.getElementsByTagName("span");

  for (const span of spans) {
    // eslint-disable-next-line unicorn/prefer-dom-node-dataset -- slimdom Element does not have dataset
    const pageNumber = span.getAttribute("data-page-number");

    if (pageNumber) {
      pageNumbers.add(+pageNumber);
    }

    span.remove();
  }

  const justificationText = document.documentElement?.textContent;

  if (!justificationText) {
    return Result.err(
      new JustificationTextError({
        message: "Justification doesn't contain any text",
      }),
    );
  }

  return Result.ok({
    justificationText,
    pageNumbers: [...pageNumbers],
  });
};

const GEMINI_B_BOX_SCALE = 1000;

export type GeminiBBox = [number, number, number, number];

type Page = {
  pageNumber: number;
  width: number;
  height: number;
};

export const parseGeminiBBoxes = (
  bBoxes: GeminiBBox[],
  { pageNumber, width, height }: Page,
): BoundingBox[] => {
  const boundingBoxHashes = new Set<string>();
  const boundingBoxes: BoundingBox[] = [];

  for (const bBox of bBoxes) {
    const hash = `${pageNumber}-${bBox.join("-")}`;

    // gemini sometimes returns duplicate bounding boxes
    if (boundingBoxHashes.has(hash)) {
      continue;
    }

    boundingBoxHashes.add(hash);

    boundingBoxes.push({
      pageNumber,
      yMin: Math.round((bBox[0] / GEMINI_B_BOX_SCALE) * height),
      xMin: Math.round((bBox[1] / GEMINI_B_BOX_SCALE) * width),
      yMax: Math.round((bBox[2] / GEMINI_B_BOX_SCALE) * height),
      xMax: Math.round((bBox[3] / GEMINI_B_BOX_SCALE) * width),
    });
  }

  return boundingBoxes;
};

const getFieldContentAsString = (content?: FieldContent) => {
  if (!content) {
    return null;
  }

  switch (content.type) {
    case "text":
    case "single-select":
      return content.value;
    case "multi-select":
      return content.value.join(",");
    case "date":
      return content.value;
    case "int":
      return content.currency
        ? `${content.value} ${content.currency}`
        : String(content.value);
    case "error":
    case "pending":
    case "unsupported":
    case "file":
    case "clip":
      return null;
    default:
      return null;
  }
};

class JustificationDataError extends TaggedError("JustificationDataError")<{
  justificationId: string;
}>() {}

export type PreparedJustificationData = {
  prompt: string;
  fieldContent: string;
  justificationText: string;
  pageNumbers: number[];
  pdf: PDF;
};

export const prepareJustificationData = async (
  organizationId: SafeId<"organization">,
  workspaceId: SafeId<"workspace">,
  justificationId: string,
  scopedDb: ScopedDb,
) =>
  await Result.gen(async function* prepareJustificationDataGen() {
    const data = await scopedDb((tx) =>
      tx.query.justifications.findFirst({
        where: { id: justificationId },
        columns: { htmlContent: true },
        with: {
          field: {
            columns: { content: true },
            with: {
              property: { columns: { tool: true } },
              entityVersion: {
                columns: {},
                with: {
                  fields: {
                    columns: { content: true },
                  },
                },
              },
            },
          },
        },
      }),
    );

    const fieldContent = getFieldContentAsString(data?.field?.content);
    const tool = data?.field?.property?.tool;
    const htmlContent = data?.htmlContent;

    if (
      !fieldContent ||
      !htmlContent ||
      tool?.type !== "ai-model" ||
      !data?.field
    ) {
      return Result.err(
        new JustificationDataError({
          justificationId,
        }),
      );
    }

    const { justificationText, pageNumbers } =
      yield* parseJustificationContent(htmlContent);

    const fileFieldContent = data.field.entityVersion?.fields.find(
      (f) => f.content.type === "file",
    )?.content;

    if (fileFieldContent?.type !== "file") {
      return Result.err(
        new JustificationDataError({
          justificationId,
        }),
      );
    }

    const pdfFileId = fileFieldContent.pdfFileId ?? fileFieldContent.id;

    if (
      !fileFieldContent.pdfFileId &&
      fileFieldContent.mimeType !== PDF_MIME_TYPE
    ) {
      return Result.err(
        new JustificationDataError({
          justificationId,
        }),
      );
    }

    const fileKey = createFileKey({
      organizationId,
      workspaceId,
      fileId: pdfFileId,
      mimeType: PDF_MIME_TYPE,
    });

    const fileBuffer = await s3.file(fileKey).arrayBuffer();
    const pdf = await PDF.load(new Uint8Array(fileBuffer));

    return Result.ok<PreparedJustificationData>({
      prompt: tool.prompt,
      fieldContent,
      justificationText,
      pageNumbers,
      pdf,
    });
  });
