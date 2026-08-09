export const DESKTOP_EDIT_FILE_TYPES = ["docx", "xlsx", "pptx"] as const;

export type DesktopEditFileType = (typeof DESKTOP_EDIT_FILE_TYPES)[number];

type DesktopEditFileTypeConfig = {
  extension: `.${DesktopEditFileType}`;
  mainPartContentType: string;
  mainPartPath: string;
  mainRootLocalName: string;
  mainRootNamespaces: readonly [string, ...string[]];
  mimeType: string;
};

export const DESKTOP_EDIT_FILE_TYPE_CONFIG = {
  docx: {
    extension: ".docx",
    mainPartContentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
    mainPartPath: "word/document.xml",
    mainRootLocalName: "document",
    mainRootNamespaces: [
      "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
      "http://purl.oclc.org/ooxml/wordprocessingml/main",
    ],
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  xlsx: {
    extension: ".xlsx",
    mainPartContentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
    mainPartPath: "xl/workbook.xml",
    mainRootLocalName: "workbook",
    mainRootNamespaces: [
      "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "http://purl.oclc.org/ooxml/spreadsheetml/main",
    ],
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  },
  pptx: {
    extension: ".pptx",
    mainPartContentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml",
    mainPartPath: "ppt/presentation.xml",
    mainRootLocalName: "presentation",
    mainRootNamespaces: [
      "http://schemas.openxmlformats.org/presentationml/2006/main",
      "http://purl.oclc.org/ooxml/presentationml/main",
    ],
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  },
} as const satisfies Record<DesktopEditFileType, DesktopEditFileTypeConfig>;

export const isDesktopEditFileType = (
  value: unknown,
): value is DesktopEditFileType =>
  typeof value === "string" &&
  DESKTOP_EDIT_FILE_TYPES.some((fileType) => fileType === value);

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
