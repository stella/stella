import {
  DESKTOP_EDIT_FILE_TYPES,
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
} from "@stll/api-contract";
import type {
  DesktopEditFileType,
  DesktopEditMimeType,
} from "@stll/api-contract";

export {
  DESKTOP_EDIT_FILE_TYPES,
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
} from "@stll/api-contract";
export type {
  DesktopEditFileType,
  DesktopEditMimeType,
} from "@stll/api-contract";

export const desktopEditFileTypeForMimeType = (
  mimeType: string,
): DesktopEditFileType | null => {
  for (const fileType of DESKTOP_EDIT_FILE_TYPES) {
    if (DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType].mimeType === mimeType) {
      return fileType;
    }
  }

  return null;
};

export const desktopEditMimeTypeForFileType = (
  fileType: DesktopEditFileType,
): DesktopEditMimeType => DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType].mimeType;
