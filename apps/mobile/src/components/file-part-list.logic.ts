import { documentFormat } from "@stll/api-contract/document-format";
import {
  type DocumentMarkKind,
  isDocumentMarkKind,
} from "@stll/ui/document-mark";

/**
 * The glyph a file is drawn with when its format has no mark of its own: the
 * family of what it holds.
 */
export type FileGlyphFamily =
  "image" | "text" | "presentation" | "email" | "archive" | "xml" | "unknown";

/**
 * How a part (or any file) is drawn: its format's own mark (the PDF, Word or
 * Excel page the matter's document list shows), else its family's glyph.
 */
export type FileTypeIcon =
  | { readonly type: "mark"; readonly mark: DocumentMarkKind }
  | { readonly type: "glyph"; readonly family: FileGlyphFamily };

/** Families of media types the format table holds no mark for. */
const FAMILY_BY_MEDIA_TYPE: ReadonlyMap<string, FileGlyphFamily> = new Map([
  ["application/vnd.oasis.opendocument.presentation", "presentation"],
  ["application/vnd.apple.keynote", "presentation"],
  ["application/zip", "archive"],
  ["application/x-zip-compressed", "archive"],
  ["application/x-7z-compressed", "archive"],
  ["application/vnd.rar", "archive"],
  ["application/x-rar-compressed", "archive"],
  ["application/gzip", "archive"],
  ["application/x-gzip", "archive"],
  ["application/x-tar", "archive"],
  ["application/x-bzip2", "archive"],
] as const);

/** The same families by a name's extension, for a type that says nothing. */
const FAMILY_BY_EXTENSION: ReadonlyMap<string, FileGlyphFamily> = new Map([
  ["odp", "presentation"],
  ["key", "presentation"],
  ["zip", "archive"],
  ["7z", "archive"],
  ["rar", "archive"],
  ["gz", "archive"],
  ["tgz", "archive"],
  ["tar", "archive"],
] as const);

const essence = (mediaType: string) =>
  (mediaType.split(";", 1).at(0) ?? "").trim().toLowerCase();

const extension = (fileName: string | null) =>
  fileName
    ?.trim()
    .match(/\.([a-z0-9]{1,8})$/iu)
    ?.at(1)
    ?.toLowerCase();

/**
 * The family of a file the format table knows only as a file: by its media
 * type first (the server reads it from the bytes), its name's extension when
 * the type tells nothing.
 */
const unmarkedFamily = (
  mediaType: string,
  fileName: string | null,
): FileGlyphFamily => {
  const type = essence(mediaType);
  const byType = FAMILY_BY_MEDIA_TYPE.get(type);
  if (byType !== undefined) {
    return byType;
  }
  // A structured suffix names the syntax underneath (RFC 6839).
  if (type.endsWith("+xml")) {
    return "xml";
  }
  const name = extension(fileName);
  const byName = name === undefined ? undefined : FAMILY_BY_EXTENSION.get(name);
  return byName ?? "unknown";
};

/**
 * The icon of a file from its media type, and its name where the type does
 * not settle it. A format with a mark draws it, exactly as a document of that
 * format draws in the matter's list; any other file draws its family's glyph.
 */
export const fileTypeIcon = (
  mediaType: string,
  fileName: string | null,
): FileTypeIcon => {
  const format = documentFormat(mediaType, fileName);
  if (isDocumentMarkKind(format.mark)) {
    return { type: "mark", mark: format.mark };
  }
  // Images, emails and text have a family of their own; any other kind is
  // read from the media type and the name.
  if (
    format.kind === "image" ||
    format.kind === "email" ||
    format.kind === "text"
  ) {
    return { type: "glyph", family: format.kind };
  }
  return { type: "glyph", family: unmarkedFamily(mediaType, fileName) };
};

/**
 * A part's short format tag ("PDF", "DOCX"), the same tag a matter's document
 * row shows; formats are not translated. Undefined when nothing names one.
 */
export const fileTypeLabel = (
  mediaType: string,
  fileName: string | null,
): string | undefined => documentFormat(mediaType, fileName).label;
