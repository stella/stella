export const DESKTOP_EDIT_FILE_TYPES = ["docx", "xlsx", "pptx"] as const;

export type DesktopEditFileType = (typeof DESKTOP_EDIT_FILE_TYPES)[number];

type DesktopEditFileTypeConfig = {
  extension: `.${DesktopEditFileType}`;
  mainPartPath: string;
  mainRootLocalName: string;
  mimeType: string;
};

export const DESKTOP_EDIT_FILE_TYPE_CONFIG = {
  docx: {
    extension: ".docx",
    mainPartPath: "word/document.xml",
    mainRootLocalName: "document",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  xlsx: {
    extension: ".xlsx",
    mainPartPath: "xl/workbook.xml",
    mainRootLocalName: "workbook",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  pptx: {
    extension: ".pptx",
    mainPartPath: "ppt/presentation.xml",
    mainRootLocalName: "presentation",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
} as const satisfies Record<DesktopEditFileType, DesktopEditFileTypeConfig>;

export const desktopEditFileTypeForMimeType = (
  mimeType: string,
): DesktopEditFileType | null => {
  const normalizedMimeType = mimeType.split(";", 1).at(0)?.trim().toLowerCase();
  if (!normalizedMimeType) {
    return null;
  }

  for (const fileType of DESKTOP_EDIT_FILE_TYPES) {
    if (
      DESKTOP_EDIT_FILE_TYPE_CONFIG[fileType].mimeType === normalizedMimeType
    ) {
      return fileType;
    }
  }

  return null;
};

export type DesktopEditMimeType =
  (typeof DESKTOP_EDIT_FILE_TYPE_CONFIG)[DesktopEditFileType]["mimeType"];
