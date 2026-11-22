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
  /** The document a signed envelope (`.p7m`) carries, as a PDF. */
  content: "content",
  /** A document of a signed container (ES3, ZEP, XZEP), as a PDF. */
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
