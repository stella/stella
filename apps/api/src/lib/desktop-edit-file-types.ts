import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "@stll/api-contract";
import type {
  DesktopEditFileType,
  DesktopEditMimeType,
} from "@stll/api-contract";

export {
  DESKTOP_EDIT_FILE_TYPES,
  DESKTOP_EDIT_FILE_TYPE_CONFIG,
  desktopEditFileTypeForMimeType,
} from "@stll/api-contract";
export type {
  DesktopEditFileType,
  DesktopEditMimeType,
} from "@stll/api-contract";

export const desktopEditMimeTypeForFileType = (
  fileType: DesktopEditFileType,
): DesktopEditMimeType => DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType].mimeType;
