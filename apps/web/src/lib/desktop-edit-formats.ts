import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "@stll/api-contract";
import type { DesktopEditFileType } from "@stll/api-contract";

import { DOCX_MIME, PPTX_MIME, XLSX_MIME } from "@/lib/consts";

export const DESKTOP_EDIT_FILE_TYPES = {
  docx: {
    application: "Word",
    ...DESKTOP_EDIT_FILE_TYPE_CONFIG.docx,
  },
  pptx: {
    application: "PowerPoint",
    ...DESKTOP_EDIT_FILE_TYPE_CONFIG.pptx,
  },
  xlsx: {
    application: "Excel",
    ...DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx,
  },
} as const satisfies Record<DesktopEditFileType, { application: string }>;

export type { DesktopEditFileType } from "@stll/api-contract";
export type DesktopEditLockState =
  | "locked-by-me"
  | "locked-by-other"
  | "unlocked";
export type DesktopEditActionContext = "bulk" | "cell" | "row";

export const canOpenDesktopEdit = ({
  context,
  fileType,
  lockState,
  readOnly,
}: {
  context: DesktopEditActionContext;
  fileType: DesktopEditFileType | null;
  lockState: DesktopEditLockState;
  readOnly: boolean;
}): boolean =>
  context === "row" &&
  !readOnly &&
  fileType !== null &&
  lockState !== "locked-by-other";

const getMimeFileType = (mimeType: string): DesktopEditFileType | null => {
  switch (mimeType) {
    case DOCX_MIME:
      return "docx";
    case PPTX_MIME:
      return "pptx";
    case XLSX_MIME:
      return "xlsx";
    default:
      return null;
  }
};

type DesktopEditFile = {
  fileName: string | null | undefined;
  mimeType: string | null | undefined;
};

export const getDesktopEditFileType = ({
  mimeType,
}: DesktopEditFile): DesktopEditFileType | null => {
  const normalizedMimeType = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!normalizedMimeType) {
    return null;
  }

  return getMimeFileType(normalizedMimeType);
};
