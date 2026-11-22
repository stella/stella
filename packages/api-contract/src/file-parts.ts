/**
 * A part of a stored file: a file inside a file, such as the document a
 * signed `.p7m` wraps, a document in a signed container, a file in a ZIP
 * archive or an email's attachment. A part is addressed by its kind and its
 * position in the list its file's preview gives, and opens through the file's
 * own audited link (`GET /files/:workspaceId/url/:fieldId?part=`). A part
 * that is itself a container (an email in an archive, an archive in a
 * data-box message) has parts of its own, addressed by the path through its
 * containers (`member:2/attachment:0`), at most `FILE_PART_MAX_DEPTH` deep.
 */

import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

export const FILE_PART_KINDS = {
  /** The document a signed envelope (`.p7m`) carries. */
  content: "content",
  /** A document of a signed container (ES3, ZEP, XZEP). */
  document: "document",
  /** A member of an ASiC or BDOC container or a ZIP archive, as stored. */
  member: "member",
  /** An attachment of an email, a data-box message or an invoice. */
  attachment: "attachment",
} as const;
export type FilePartKind =
  (typeof FILE_PART_KINDS)[keyof typeof FILE_PART_KINDS];

/** Positions run to the largest list any file part reader returns. */
export const FILE_PART_MAX_INDEX = 9999;

/** How many containers deep a part may sit; a part of the file itself is 1. */
export const FILE_PART_MAX_DEPTH = 4;

const SEGMENT_SOURCE =
  "(content|document|member|attachment):(0|[1-9][0-9]{0,3})";
const SEGMENT_PATTERN = new RegExp(`^${SEGMENT_SOURCE}$`, "u");
const FILE_PART_PATTERN = new RegExp(
  `^${SEGMENT_SOURCE}(?:/${SEGMENT_SOURCE}){0,${String(FILE_PART_MAX_DEPTH - 1)}}$`,
  "u",
);

export type FilePart = {
  readonly kind: FilePartKind;
  readonly index: number;
  /** The part this one sits in; absent for a part of the file itself. */
  readonly within?: FilePart;
};

/** How many containers deep a part sits; a part of the file itself is 1. */
export const filePartDepth = (part: FilePart): number =>
  part.within === undefined ? 1 : filePartDepth(part.within) + 1;

/** A part's address, such as `attachment:2` or `member:0/attachment:2`. */
export const filePartId = ({ kind, index, within }: FilePart): string =>
  `${within === undefined ? "" : `${filePartId(within)}/`}${kind}:${String(index)}`;

const parseSegment = (value: string): FilePart | null => {
  const match = SEGMENT_PATTERN.exec(value);
  const kind = Object.values(FILE_PART_KINDS).find(
    (candidate) => candidate === match?.[1],
  );
  const index = parseIntegerToken(match?.[2], { sign: "unsigned" });
  return kind === undefined || index.isErr()
    ? null
    : { kind, index: index.value };
};

/** The part an address names, or null for any other string. */
export const parseFilePartId = (value: string): FilePart | null => {
  if (!FILE_PART_PATTERN.test(value)) {
    return null;
  }
  let part: FilePart | null = null;
  for (const segment of value.split("/")) {
    const parsed = parseSegment(segment);
    if (parsed === null) {
      return null;
    }
    part = part === null ? parsed : { ...parsed, within: part };
  }
  return part;
};

export const filePartIdSchema = v.pipe(
  v.string(),
  v.maxLength(16 * FILE_PART_MAX_DEPTH),
  v.regex(FILE_PART_PATTERN, "Expected a file part such as attachment:0"),
);

/**
 * One part as its file's preview lists it, ready for the shared part list:
 * where it opens, its name, what it is and how large it is. The media type
 * is read from the part's own bytes on the server, falling back to what the
 * container states (or the part's name implies) when the bytes do not show
 * it; the part link delivers the part as that type.
 */
export const filePartDescriptorEntries = {
  /** Opens the part through the file's link (`?part=`). */
  part: filePartIdSchema,
  /** Its name in the container; null when the container gives none. */
  fileName: v.nullable(v.string()),
  mediaType: v.pipe(v.string(), v.minLength(1), v.maxLength(255)),
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
};

/**
 * Text a part previews as, shown and never rendered: plain, CSV and XML.
 * Every other type previews as itself or not at all.
 */
const FILE_PART_TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "text/xml",
  "application/xml",
]);

/** Whether a part of this media type previews as text. */
export const isFilePartTextMediaType = (mediaType: string): boolean =>
  FILE_PART_TEXT_MEDIA_TYPES.has(
    (mediaType.split(";", 1).at(0) ?? "").trim().toLowerCase(),
  );

/** How much of a text part its in-place preview shows. */
export const FILE_PART_TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/**
 * The bytes the part link delivers inline (for display): a text part is cut
 * one byte past what its preview shows, so the reader knows it was cut
 * without fetching the rest; anything else, and every download, is whole.
 */
export const filePartInlineBytes = (
  bytes: Uint8Array,
  mediaType: string,
): Uint8Array =>
  isFilePartTextMediaType(mediaType) &&
  bytes.byteLength > FILE_PART_TEXT_PREVIEW_MAX_BYTES + 1
    ? bytes.subarray(0, FILE_PART_TEXT_PREVIEW_MAX_BYTES + 1)
    : bytes;

export const filePartDescriptorSchema = v.object(filePartDescriptorEntries);
export type FilePartDescriptor = v.InferOutput<typeof filePartDescriptorSchema>;

/**
 * Why a file a container holds does not open: it is password-protected, its
 * compression method is one the reader does not read, it is a link to
 * another path (never followed), it is larger than one file a container may
 * hold, or its entry is damaged.
 */
export const FILE_PART_UNAVAILABLE_REASONS = [
  "encrypted",
  "unsupported",
  "link",
  "tooLarge",
  "unreadable",
] as const;

export type FilePartUnavailableReason =
  (typeof FILE_PART_UNAVAILABLE_REASONS)[number];

/**
 * A file a container holds, listed whether or not it opens: its name and the
 * folders it sits in are shown as the container states them and are never
 * used as a path; it opens through `part` when it can.
 */
export const containedFileEntries = {
  fileName: v.string(),
  /** The folders it sits in (`smlouvy/2026`); null at the container's top. */
  folder: v.nullable(v.string()),
  /** Its size as the container states it. */
  sizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** The file as a part; null when it does not open. */
  part: v.nullable(filePartDescriptorSchema),
  /** Why it does not open; null when it does. */
  unavailable: v.nullable(v.picklist(FILE_PART_UNAVAILABLE_REASONS)),
};

export const containedFileSchema = v.object(containedFileEntries);
export type ContainedFile = v.InferOutput<typeof containedFileSchema>;

/**
 * The files of a part that is itself a container (an email in an archive, an
 * archive in a data-box message), in the container's order, each with the
 * path that opens it (`GET /files/:workspaceId/parts/:fieldId?part=`).
 */
export const filePartListSchema = v.object({
  files: v.array(containedFileSchema),
});
export type FilePartList = v.InferOutput<typeof filePartListSchema>;
