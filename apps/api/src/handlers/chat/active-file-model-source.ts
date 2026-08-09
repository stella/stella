import type { FieldContent } from "@/api/db/schema-validators";
import { isNativelyRenderableMimeType } from "@/api/lib/files/pdf-derivative-policy";
import { isOfficeDocumentMimeType } from "@/api/lib/search/extractable-mime-types";
import { PDF_MIME_TYPE } from "@/api/mime-types";

export type ActiveFileSourceForModel =
  | {
      type: "pdf";
      fileId: string;
      fileName: string;
      mimeType: typeof PDF_MIME_TYPE;
      knownSizeBytes: number | null;
    }
  | {
      type: "extracted-text";
      fileId: string;
      fileName: string;
      mimeType: string;
      knownSizeBytes: number;
    };

export type ActiveFileModelBinding =
  | { type: "durable-current" }
  | {
      type: "direct";
      source: ActiveFileSourceForModel;
      version: "current" | "historical";
    };

export const getActiveFileSourceForModel = (
  content: Extract<FieldContent, { type: "file" }>,
): ActiveFileSourceForModel | null => {
  if (content.encrypted) {
    return null;
  }

  if (content.mimeType === PDF_MIME_TYPE) {
    return {
      type: "pdf",
      fileId: content.id,
      fileName: content.fileName,
      knownSizeBytes: content.sizeBytes,
      mimeType: PDF_MIME_TYPE,
    };
  }

  if (content.pdfFileId !== null) {
    return {
      type: "pdf",
      fileId: content.pdfFileId,
      fileName: content.fileName,
      knownSizeBytes: null,
      mimeType: PDF_MIME_TYPE,
    };
  }

  return isNativelyRenderableMimeType(content.mimeType) &&
    isOfficeDocumentMimeType(content.mimeType)
    ? {
        type: "extracted-text",
        fileId: content.id,
        fileName: content.fileName,
        knownSizeBytes: content.sizeBytes,
        mimeType: content.mimeType,
      }
    : null;
};

type ActiveFileExtractedContent = {
  charCount: number;
  sourceEntityVersionId: string | null;
  sourceFieldId: string | null;
  sourceFileId: string | null;
  sourceSha256Hex: string | null;
};

type GetActiveFileModelBindingOptions = {
  content: Extract<FieldContent, { type: "file" }>;
  currentVersionId: string | null;
  extractedContent: ActiveFileExtractedContent | null;
  fieldId: string;
  fieldVersionId: string;
};

export const getActiveFileModelBinding = ({
  content,
  currentVersionId,
  extractedContent,
  fieldId,
  fieldVersionId,
}: GetActiveFileModelBindingOptions): ActiveFileModelBinding | null => {
  const source = getActiveFileSourceForModel(content);
  if (source === null) {
    return null;
  }

  const version =
    currentVersionId === fieldVersionId ? "current" : "historical";
  const hasExactCurrentExtraction =
    version === "current" &&
    extractedContent !== null &&
    extractedContent.charCount > 0 &&
    extractedContent.sourceEntityVersionId === fieldVersionId &&
    extractedContent.sourceFieldId === fieldId &&
    extractedContent.sourceFileId === content.id &&
    extractedContent.sourceSha256Hex === content.sha256Hex;
  if (hasExactCurrentExtraction) {
    return { type: "durable-current" };
  }

  return { source, type: "direct", version };
};
