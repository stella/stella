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
    }
  | {
      type: "extracted-text";
      fileId: string;
      fileName: string;
      mimeType: string;
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
      mimeType: PDF_MIME_TYPE,
    };
  }

  if (content.pdfFileId !== null) {
    return {
      type: "pdf",
      fileId: content.pdfFileId,
      fileName: content.fileName,
      mimeType: PDF_MIME_TYPE,
    };
  }

  return isNativelyRenderableMimeType(content.mimeType) &&
    isOfficeDocumentMimeType(content.mimeType)
    ? {
        type: "extracted-text",
        fileId: content.id,
        fileName: content.fileName,
        mimeType: content.mimeType,
      }
    : null;
};

type GetActiveFileModelBindingOptions = {
  content: Extract<FieldContent, { type: "file" }>;
  currentVersionId: string | null;
  extractedCharCount: number | null;
  fieldVersionId: string;
};

export const getActiveFileModelBinding = ({
  content,
  currentVersionId,
  extractedCharCount,
  fieldVersionId,
}: GetActiveFileModelBindingOptions): ActiveFileModelBinding | null => {
  const source = getActiveFileSourceForModel(content);
  if (source === null) {
    return null;
  }

  const version =
    currentVersionId === fieldVersionId ? "current" : "historical";
  if (version === "current" && (extractedCharCount ?? 0) > 0) {
    return { type: "durable-current" };
  }

  return { source, type: "direct", version };
};
