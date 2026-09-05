import { panic } from "better-result";

import {
  DOCUMENT_PROPERTIES_MAX_BYTES,
  hasDocumentProperties,
} from "@stll/api-contract";

import { PDF_MIME_TYPE } from "@/consts";
import type {
  FieldId,
  OcrExportStatus,
  PropertyId,
  WorkspaceEntity,
} from "@/lib/types";

export type OcrSource = {
  encrypted: boolean;
  exportStatus: OcrExportStatus;
  fieldId: FieldId;
  fileName: string;
  mimeType: string;
};

export type RowActionContext = "bulk" | "cell" | "row";
export type OcrExportFormat = "searchable-pdf" | "text";

export const canDownloadScrubbed = (file: {
  encrypted: boolean;
  mimeType: string;
  sizeBytes: number;
}): boolean =>
  !file.encrypted &&
  file.sizeBytes <= DOCUMENT_PROPERTIES_MAX_BYTES &&
  hasDocumentProperties(file.mimeType);

/**
 * The searchable PDF is a stored derivative that can lag or fail behind the
 * text, so an export offer is per format rather than per source.
 */
export const getOcrExportFormats = (
  exportStatus: OcrExportStatus,
): readonly OcrExportFormat[] => {
  switch (exportStatus) {
    case "text-and-pdf":
      return ["searchable-pdf", "text"];
    case "text":
      return ["text"];
    case "unavailable":
      return [];
    default:
      exportStatus satisfies never;
      return panic(`Unhandled export status: ${String(exportStatus)}`);
  }
};

export const hasOcrExport = (source: OcrSource): boolean =>
  getOcrExportFormats(source.exportStatus).length > 0;

type GetOcrSourceInput = {
  fields: WorkspaceEntity["fields"];
  propertyId: PropertyId | null | undefined;
};

// OCR is scoped to the file field the user selected. Do not fall back to the
// first entity file: entities can have multiple file fields with distinct
// documents and access expectations.
export const getOcrSource = ({
  fields,
  propertyId,
}: GetOcrSourceInput): OcrSource | null => {
  if (propertyId === null || propertyId === undefined) {
    return null;
  }

  const field = fields[propertyId];
  if (!field || field.content.type !== "file") {
    return null;
  }

  return {
    encrypted: field.content.encrypted,
    exportStatus: field.ocrExportStatus ?? "unavailable",
    fieldId: field.id,
    fileName: field.content.fileName,
    mimeType: field.content.mimeType,
  };
};

export const getOcrSources = (fields: WorkspaceEntity["fields"]): OcrSource[] =>
  Object.values(fields).flatMap((field) => {
    if (!field || field.content.type !== "file") {
      return [];
    }
    return [
      {
        encrypted: field.content.encrypted,
        exportStatus: field.ocrExportStatus ?? "unavailable",
        fieldId: field.id,
        fileName: field.content.fileName,
        mimeType: field.content.mimeType,
      },
    ];
  });

type CanRunManualOcrInput = {
  context: RowActionContext;
  entity: Pick<WorkspaceEntity, "kind" | "readOnly">;
  ocrSource: OcrSource | undefined;
};

export const canRunManualOcr = ({
  context,
  entity,
  ocrSource,
}: CanRunManualOcrInput): boolean =>
  context !== "bulk" &&
  entity.kind !== "folder" &&
  !entity.readOnly &&
  ocrSource !== undefined &&
  !ocrSource.encrypted &&
  ocrSource.mimeType === PDF_MIME_TYPE;

export const getPdfDownloadFileName = (fileName: string): string => {
  const dotIndex = fileName.lastIndexOf(".");

  if (dotIndex <= 0) {
    return `${fileName}.pdf`;
  }

  return `${fileName.slice(0, dotIndex)}.pdf`;
};

export const getOcrExportFileName = (
  fileName: string,
  format: OcrExportFormat,
): string => {
  const dotIndex = fileName.lastIndexOf(".");
  const baseName = dotIndex <= 0 ? fileName : fileName.slice(0, dotIndex);
  return format === "searchable-pdf"
    ? `${baseName}-searchable.pdf`
    : `${baseName}.txt`;
};

export const getDesktopEditLockState = (
  activeEditBy: { isMe: boolean } | null,
) => {
  if (!activeEditBy) {
    return "unlocked";
  }

  return activeEditBy.isMe ? "locked-by-me" : "locked-by-other";
};
