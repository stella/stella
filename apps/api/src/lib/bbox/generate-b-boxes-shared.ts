import { PDF } from "@libpdf/core";
import { Result, TaggedError } from "better-result";

import type { ScopedDb } from "@/api/db";
import type {
  DocxFolioJustificationBlock,
  JustificationBlock,
  JustificationContent,
} from "@/api/db/schema";
import type { FieldContent } from "@/api/db/schema-validators";
import { createFileKey } from "@/api/handlers/files/utils";
import type { OrgAIConfig } from "@/api/lib/ai-models";
import type { SafeId } from "@/api/lib/branded-types";
import { getS3 } from "@/api/lib/s3";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import type { BoundingBox } from "@/api/types";

export type GenerateBBoxesProps = {
  abortSignal: AbortSignal;
  justificationId: SafeId<"justification">;
  organizationId: SafeId<"organization">;
  orgAIConfig?: OrgAIConfig | null;
  workspaceId: SafeId<"workspace">;
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

// Narrows a `JustificationBlock` to `DocxFolioJustificationBlock`. A
// missing `kind` (legacy rows from before the discriminator landed)
// means pdf-bates by definition, so this guard returns false for
// undefined too — and the caller continues processing the block.
const isDocxFolioBlock = (
  block: JustificationBlock,
): block is DocxFolioJustificationBlock =>
  (block as { kind?: unknown }).kind === "docx-folio";

export const extractJustificationContent = (
  justification: JustificationContent,
) => {
  const pageNumbers = new Set<number>();
  const textParts: string[] = [];

  for (const block of justification.blocks) {
    // bbox generation only applies to PDF citations. DOCX blocks
    // ship folio block IDs and are rendered by the editor, not the
    // PDF preview — skip them here.
    //
    // Backward-compat: rows persisted before the discriminator
    // landed have no `kind` field (the old `JustificationContent`
    // shape was `{ fileFieldId, statements }`). Treat a missing
    // `kind` as `pdf-bates` so historical PDF justifications still
    // produce bounding boxes.
    if (isDocxFolioBlock(block)) {
      continue;
    }
    for (const statement of block.statements) {
      const text = statement.text.trim();
      if (text.length > 0) {
        textParts.push(text);
      }

      for (const citation of statement.citations) {
        // Pre-discriminator citations are always pdf-bates shape;
        // narrowing to PdfBates above guarantees `pageNumber`.
        pageNumbers.add(citation.pageNumber);
      }
    }
  }

  const justificationText = textParts.join(" ");

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

type GeminiBBox = [number, number, number, number];

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
  justificationId: SafeId<"justification">;
}>() {}

export const prepareJustificationData = async (
  organizationId: SafeId<"organization">,
  workspaceId: SafeId<"workspace">,
  justificationId: SafeId<"justification">,
  scopedDb: ScopedDb,
) =>
  await Result.gen(async function* () {
    const data = await scopedDb((tx) =>
      tx.query.justifications.findFirst({
        where: { id: { eq: justificationId } },
        columns: { content: true },
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
    const content = data?.content;

    if (
      !fieldContent ||
      !content ||
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
      yield* extractJustificationContent(content);

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

    const fileBuffer = await getS3().file(fileKey).arrayBuffer();
    const pdf = await PDF.load(new Uint8Array(fileBuffer));

    return Result.ok({
      prompt: tool.prompt,
      fieldContent,
      justificationText,
      pageNumbers,
      pdf,
    });
  });
