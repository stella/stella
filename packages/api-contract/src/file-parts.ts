/**
 * A part of a stored file: a file inside a file, such as the document a
 * signed `.p7m` wraps, a document in a signed container or an email's
 * attachment. A part is addressed by its kind and its position in the list
 * its file's preview gives, and opens through the file's own audited link
 * (`GET /files/:workspaceId/url/:fieldId?part=`).
 */

import * as v from "valibot";

import { parseIntegerToken } from "@stll/agent-input/numeric-token";

export const FILE_PART_KINDS = {
  /** The document a signed envelope (`.p7m`) carries. */
  content: "content",
  /** A document of a signed container (ES3, ZEP, XZEP). */
  document: "document",
  /** A member of an ASiC or BDOC container, as it is stored. */
  member: "member",
  /** An attachment of an email, a data-box message or an invoice. */
  attachment: "attachment",
} as const;
export type FilePartKind =
  (typeof FILE_PART_KINDS)[keyof typeof FILE_PART_KINDS];

/** Positions run to the largest list any file part reader returns. */
export const FILE_PART_MAX_INDEX = 9999;

const FILE_PART_PATTERN =
  /^(content|document|member|attachment):(0|[1-9][0-9]{0,3})$/u;

export type FilePart = { readonly kind: FilePartKind; readonly index: number };

/** A part's address, such as `attachment:2`. */
export const filePartId = ({ kind, index }: FilePart): string =>
  `${kind}:${String(index)}`;

/** The part an address names, or null for any other string. */
export const parseFilePartId = (value: string): FilePart | null => {
  const match = FILE_PART_PATTERN.exec(value);
  const kind = Object.values(FILE_PART_KINDS).find(
    (candidate) => candidate === match?.[1],
  );
  const index = parseIntegerToken(match?.[2], { sign: "unsigned" });
  return kind === undefined || index.isErr()
    ? null
    : { kind, index: index.value };
};

export const filePartIdSchema = v.pipe(
  v.string(),
  v.maxLength(16),
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
