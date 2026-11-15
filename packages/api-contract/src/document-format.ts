import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "./desktop-edit-file-types";
import { EML_MIME_TYPE, MSG_MIME_TYPE } from "./email-mime-types";

/** The family a file's mark stands for; each has its own mark. */
export type DocumentFormatKind =
  | "pdf"
  | "word"
  | "rtf"
  | "openDocumentText"
  | "excel"
  | "powerpoint"
  | "openDocumentSheet"
  | "csv"
  | "image"
  | "email"
  | "markdown"
  | "text"
  | "file";

/** A file's format: its mark, and its short tag ("PDF", "DOCX"), if any. */
export type DocumentFormat = {
  readonly kind: DocumentFormatKind;
  readonly label: string | undefined;
};

type FormatEntry = {
  readonly kind: Exclude<DocumentFormatKind, "file">;
  /** The format's short tag. Formats are not translated. */
  readonly label: string;
  readonly mimeTypes: readonly string[];
  readonly extensions: readonly string[];
};

/**
 * Every format a file is recognised as, by media type and by extension. A
 * format's mark is reserved for it: RTF, ODT and ODS are not Word or Excel.
 */
const DOCUMENT_FORMATS: readonly FormatEntry[] = [
  {
    kind: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    extensions: [".pdf"],
  },
  {
    kind: "word",
    label: "DOC",
    mimeTypes: ["application/msword"],
    extensions: [".doc"],
  },
  {
    kind: "word",
    label: "DOCX",
    mimeTypes: [DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.mimeType],
    extensions: [DESKTOP_EDIT_FILE_TYPE_CONFIG.docx.extension],
  },
  {
    kind: "rtf",
    label: "RTF",
    mimeTypes: ["application/rtf", "text/rtf"],
    extensions: [".rtf"],
  },
  {
    kind: "openDocumentText",
    label: "ODT",
    mimeTypes: ["application/vnd.oasis.opendocument.text"],
    extensions: [".odt"],
  },
  {
    kind: "excel",
    label: "XLS",
    mimeTypes: ["application/vnd.ms-excel"],
    extensions: [".xls"],
  },
  {
    kind: "excel",
    label: "XLSX",
    mimeTypes: [DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.mimeType],
    extensions: [DESKTOP_EDIT_FILE_TYPE_CONFIG.xlsx.extension],
  },
  {
    kind: "powerpoint",
    label: "PPT",
    mimeTypes: ["application/vnd.ms-powerpoint"],
    extensions: [".ppt"],
  },
  {
    kind: "powerpoint",
    label: "PPTX",
    mimeTypes: [DESKTOP_EDIT_FILE_TYPE_CONFIG.pptx.mimeType],
    extensions: [DESKTOP_EDIT_FILE_TYPE_CONFIG.pptx.extension],
  },
  {
    kind: "openDocumentSheet",
    label: "ODS",
    mimeTypes: ["application/vnd.oasis.opendocument.spreadsheet"],
    extensions: [".ods"],
  },
  {
    kind: "csv",
    label: "CSV",
    mimeTypes: ["text/csv", "application/csv"],
    extensions: [".csv"],
  },
  {
    kind: "image",
    label: "JPEG",
    mimeTypes: ["image/jpeg"],
    extensions: [".jpg", ".jpeg"],
  },
  {
    kind: "image",
    label: "PNG",
    mimeTypes: ["image/png"],
    extensions: [".png"],
  },
  {
    kind: "image",
    label: "GIF",
    mimeTypes: ["image/gif"],
    extensions: [".gif"],
  },
  {
    kind: "image",
    label: "WEBP",
    mimeTypes: ["image/webp"],
    extensions: [".webp"],
  },
  {
    kind: "email",
    label: "EML",
    mimeTypes: [EML_MIME_TYPE],
    extensions: [".eml"],
  },
  {
    kind: "email",
    label: "MSG",
    mimeTypes: [MSG_MIME_TYPE],
    extensions: [".msg"],
  },
  {
    kind: "markdown",
    label: "MD",
    mimeTypes: ["text/markdown"],
    extensions: [".md", ".markdown"],
  },
];

const PLAIN_TEXT: FormatEntry = {
  kind: "text",
  label: "TXT",
  mimeTypes: ["text/plain"],
  extensions: [".txt"],
};

// Maps, so a media type or extension named like an object key
// ("constructor") finds nothing rather than an inherited property.
const BY_MIME_TYPE: ReadonlyMap<string, FormatEntry> = new Map(
  DOCUMENT_FORMATS.flatMap((entry) =>
    entry.mimeTypes.map((mimeType) => [mimeType, entry] as const),
  ),
);

const BY_EXTENSION: ReadonlyMap<string, FormatEntry> = new Map(
  [...DOCUMENT_FORMATS, PLAIN_TEXT].flatMap((entry) =>
    entry.extensions.map((extension) => [extension, entry] as const),
  ),
);

const extensionOf = (fileName: string | null | undefined): string | null => {
  const extension = fileName?.trim().match(/(\.[a-z0-9]{1,8})$/iu)?.[1];
  return extension === undefined ? null : extension.toLowerCase();
};

/** A name's extension as a tag ("výpis.Xlsx" is "XLSX"), for formats unknown. */
const extensionLabel = (
  fileName: string | null | undefined,
): string | undefined =>
  fileName
    ?.trim()
    .match(/\.([a-z0-9]{1,5})$/iu)?.[1]
    ?.toUpperCase();

const formatOf = (entry: FormatEntry): DocumentFormat => ({
  kind: entry.kind,
  label: entry.label,
});

/**
 * A file's format from its media type, else its name's extension. A plain
 * text type is the weakest hint: "notes.md" stored as text/plain is Markdown,
 * and only a text file with no better name is plain text.
 */
export const documentFormat = (
  mimeType: string | null | undefined,
  fileName?: string | null,
): DocumentFormat => {
  const media = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const byMimeType = BY_MIME_TYPE.get(media);
  if (byMimeType !== undefined) {
    return formatOf(byMimeType);
  }
  const extension = extensionOf(fileName);
  const byExtension =
    extension === null ? undefined : BY_EXTENSION.get(extension);
  if (byExtension !== undefined) {
    return formatOf(byExtension);
  }
  if (media === "text/plain") {
    return formatOf(PLAIN_TEXT);
  }
  // A type outside the table still names its family: an image/heic photo is
  // an image, as an unlisted text/ type is text.
  const label = extensionLabel(fileName);
  if (media.startsWith("image/")) {
    return { kind: "image", label };
  }
  if (media.startsWith("text/")) {
    return { kind: "text", label };
  }
  return { kind: "file", label };
};
