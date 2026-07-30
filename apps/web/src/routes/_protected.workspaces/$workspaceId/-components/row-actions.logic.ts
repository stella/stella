import { PDF_MIME_TYPE } from "@/consts";
import type { FieldId, PropertyId, WorkspaceEntity } from "@/lib/types";

export type OcrSource = {
  encrypted: boolean;
  fieldId: FieldId;
  mimeType: string;
};

export type RowActionContext = "bulk" | "cell" | "row";

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
    fieldId: field.id,
    mimeType: field.content.mimeType,
  };
};

type CanRunManualOcrInput = {
  context: RowActionContext;
  documentOcrAvailable: boolean;
  entity: Pick<WorkspaceEntity, "kind" | "readOnly">;
  ocrSource: OcrSource | undefined;
};

export const canRunManualOcr = ({
  context,
  documentOcrAvailable,
  entity,
  ocrSource,
}: CanRunManualOcrInput): boolean =>
  context !== "bulk" &&
  documentOcrAvailable &&
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

export const getDesktopEditLockState = (
  activeEditBy: { isMe: boolean } | null,
) => {
  if (!activeEditBy) {
    return "unlocked";
  }

  return activeEditBy.isMe ? "locked-by-me" : "locked-by-other";
};
