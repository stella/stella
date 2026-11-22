import {
  CONVERTED_DOCUMENT_FORMATS,
  HTML_RENDERED_DOCUMENT_FORMATS,
} from "./converted-document-formats";
import { DESKTOP_EDIT_FILE_TYPE_CONFIG } from "./desktop-edit-file-types";
import { EML_MIME_TYPE, MSG_MIME_TYPE } from "./email-mime-types";
import {
  LEGAL_FILE_FORMATS,
  type LegalFileFormatKind,
  legalFileFormatProfiles,
  XML_FILE_FORMAT,
  ZIP_FILE_FORMAT,
} from "./legal-file-formats";

/**
 * Media types that only say a file is XML or a ZIP archive. Many formats are
 * uploaded under them (an invoice as XML, an ASiC container or an Office
 * document as a ZIP), so a name whose extension names a format is that
 * format.
 */
const GENERIC_MEDIA_TYPES: ReadonlySet<string> = new Set([
  XML_FILE_FORMAT.mimeType,
  ...XML_FILE_FORMAT.mimeAliases,
  ZIP_FILE_FORMAT.mimeType,
  ...ZIP_FILE_FORMAT.mimeAliases,
]);

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
  | LegalFileFormatKind
  | "markdown"
  | "text"
  | "file";

/**
 * A file's format: its family, the mark it is drawn with, and its short tag
 * ("PDF", "DOCX"), if any. The mark is the family's own unless a profile of
 * the family names one of its own (BDOC within ASiC-E); `@stll/ui`'s
 * `DOCUMENT_MARKS` holds the artwork under the same key.
 */
export type DocumentFormat = {
  readonly kind: DocumentFormatKind;
  readonly mark: string;
  readonly label: string | undefined;
};

type FormatEntry = {
  /** "file" for a format known by its tag that has no mark of its own. */
  readonly kind: DocumentFormatKind;
  /** The mark's key, when it is not the kind's own. */
  readonly mark?: string;
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
  ...[...CONVERTED_DOCUMENT_FORMATS, ...HTML_RENDERED_DOCUMENT_FORMATS].map(
    ({ label, mimeType, mimeAliases, extensions }): FormatEntry => ({
      kind: "file",
      label,
      mimeTypes: [mimeType, ...mimeAliases],
      extensions,
    }),
  ),
  // A profile follows its format, so its extensions name it rather than the
  // format; the format alone answers to the shared media type.
  ...LEGAL_FILE_FORMATS.flatMap((format): FormatEntry[] => [
    {
      kind: format.kind,
      label: format.label,
      mimeTypes: [format.mimeType, ...format.mimeAliases],
      extensions: format.extensions,
    },
    ...legalFileFormatProfiles(format).map(({ extensions, label, mark }) => ({
      kind: format.kind,
      mark,
      label,
      mimeTypes: [],
      extensions,
    })),
  ]),
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

const markOf = (entry: FormatEntry): string => entry.mark ?? entry.kind;

const formatOf = (entry: FormatEntry): DocumentFormat => ({
  kind: entry.kind,
  mark: markOf(entry),
  label: entry.label,
});

/**
 * A file's format from its media type, else its name's extension. A plain
 * text type is the weakest hint: "notes.md" stored as text/plain is Markdown,
 * and only a text file with no better name is plain text. A profile shares
 * its format's media type, so where both name the same family, the name's
 * profile (a ".bdoc" stored as ASiC-E) keeps its own tag and mark.
 */
export const documentFormat = (
  mimeType: string | null | undefined,
  fileName?: string | null,
): DocumentFormat => {
  const media = mimeType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const byMimeType = BY_MIME_TYPE.get(media);
  const extension = extensionOf(fileName);
  const byExtension =
    extension === null ? undefined : BY_EXTENSION.get(extension);
  if (
    byExtension !== undefined &&
    byExtension.kind !== byMimeType?.kind &&
    GENERIC_MEDIA_TYPES.has(media)
  ) {
    return formatOf(byExtension);
  }
  if (byMimeType !== undefined) {
    return formatOf(
      byExtension?.kind === byMimeType.kind &&
        markOf(byExtension) !== markOf(byMimeType)
        ? byExtension
        : byMimeType,
    );
  }
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
    return { kind: "image", mark: "image", label };
  }
  if (media.startsWith("text/")) {
    return { kind: "text", mark: "text", label };
  }
  return { kind: "file", mark: "file", label };
};

export const legalFileFormat = (
  mimeType?: string | null,
  fileName?: string | null,
) => {
  const { kind } = documentFormat(mimeType, fileName);
  return LEGAL_FILE_FORMATS.find((format) => format.kind === kind);
};
