import {
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
  desktopEditFileTypeForMimeType,
} from "@stll/api-contract";
import type { DesktopEditFileType } from "@stll/api-contract";

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

type DesktopEditFile = {
  fileName: string | null | undefined;
  mimeType: string | null | undefined;
  multiFormatEnabled: boolean;
};

export const getDesktopEditFileType = ({
  mimeType,
  multiFormatEnabled,
}: DesktopEditFile): DesktopEditFileType | null => {
  const fileType = mimeType ? desktopEditFileTypeForMimeType(mimeType) : null;
  if (fileType === null || fileType === "docx" || multiFormatEnabled) {
    return fileType;
  }
  return null;
};
