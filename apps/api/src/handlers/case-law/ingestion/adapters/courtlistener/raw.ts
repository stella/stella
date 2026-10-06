// parser-output-unchanged: The SHA-256 owner receives identical UTF-8 inputs and emits the same lowercase hexadecimal digests; adapter fixture and fingerprint vectors retain the output.
import { Result, TaggedError } from "better-result";
/**
 * The stored raw of a CourtListener record and the hash that decides whether
 * a later edition of it changed anything.
 *
 * Each part is JSON with every code unit past printable ASCII written as a
 * `\uXXXX` escape. The envelope then holds no character the shared text
 * sanitizer removes, so NUL, zero-width and unpaired surrogate code units in
 * publisher text survive storage and decode to the exact original strings.
 */

import { sha256Hex as hashContent } from "@stll/sha256/bun";
import { stableStringify } from "@stll/stable-stringify";

import {
  decodeSourceRawEnvelope,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/ingestion-types";
import { isRecord } from "@/api/lib/type-guards";

import {
  COURTLISTENER_RECORD_VERSION,
  type CourtListenerRecordV1,
} from "./record";
import { compareCanonicalIds } from "./snapshot-columns";

export const COURTLISTENER_RAW_PART = {
  CONTRACT: "cl-contract",
  CLUSTER: "cl-cluster",
  DOCKET: "cl-docket",
  COURT: "cl-court",
  OPINIONS: "cl-opinions",
  CITATIONS: "cl-citations",
  JUDGE_RELATIONS: "cl-judge-relations",
} as const;

const PART_NAMES: ReadonlySet<string> = new Set(
  Object.values(COURTLISTENER_RAW_PART),
);

const OUTSIDE_PRINTABLE_ASCII = /[^ -~]/gu;

const hex = (unit: number): string =>
  `\\u${unit.toString(16).padStart(4, "0")}`;

/** One code point as JSON's UTF-16 escapes: a surrogate pair past U+FFFF. */
const escapeCodePoint = (match: string): string => {
  const point = match.codePointAt(0) ?? 0;
  if (point <= 0xff_ff) {
    return hex(point);
  }
  const offset = point - 0x1_00_00;
  return (
    hex(0xd8_00 + Math.floor(offset / 0x4_00)) +
    hex(0xdc_00 + (offset % 0x4_00))
  );
};

/** JSON text that is printable ASCII only; `JSON.parse` restores every string. */
const asciiJson = (json: string): string =>
  json.replace(OUTSIDE_PRINTABLE_ASCII, escapeCodePoint);

const byId = <TRow extends { readonly id: string }>(
  rows: readonly TRow[],
): TRow[] =>
  rows.toSorted((left, right) => compareCanonicalIds(left.id, right.id));

/**
 * Everything the publisher states about the cluster, in an order the loader
 * cannot influence. Provenance is left out: a repeated transfer of the same
 * edition, from another URL or under another ETag, is the same content.
 */
const hashSubject = (record: CourtListenerRecordV1) => ({
  version: record.version,
  cluster: record.cluster,
  docket: record.docket,
  court: record.court,
  opinions: byId(record.opinions),
  citations: byId(record.citations),
  judgeRelations:
    record.judgeRelations.status === "complete"
      ? {
          status: record.judgeRelations.status,
          people: byId(record.judgeRelations.people),
          joinedBy: record.judgeRelations.joinedBy.toSorted(
            (left, right) =>
              compareCanonicalIds(left.opinionId, right.opinionId) ||
              compareCanonicalIds(left.personId, right.personId),
          ),
        }
      : { status: record.judgeRelations.status },
});

export const courtListenerRawHash = (record: CourtListenerRecordV1): string =>
  hashContent(asciiJson(stableStringify(hashSubject(record))));

/** The record's own tables, by the envelope part each is kept as. */
const TABLE_PARTS = {
  [COURTLISTENER_RAW_PART.CLUSTER]: "cluster",
  [COURTLISTENER_RAW_PART.DOCKET]: "docket",
  [COURTLISTENER_RAW_PART.COURT]: "court",
  [COURTLISTENER_RAW_PART.OPINIONS]: "opinions",
  [COURTLISTENER_RAW_PART.CITATIONS]: "citations",
  [COURTLISTENER_RAW_PART.JUDGE_RELATIONS]: "judgeRelations",
} as const satisfies Record<string, keyof CourtListenerRecordV1>;

/** The envelope stored as `sourceRaw`, one part per table of the record. */
export const encodeCourtListenerRaw = (record: CourtListenerRecordV1): string =>
  encodeSourceRawEnvelope(
    Object.fromEntries([
      [
        COURTLISTENER_RAW_PART.CONTRACT,
        asciiJson(
          JSON.stringify({
            version: record.version,
            provenance: record.provenance,
          }),
        ),
      ] as const,
      ...Object.entries(TABLE_PARTS).map(
        ([part, key]) =>
          [part, asciiJson(JSON.stringify(record[key]))] as const,
      ),
    ]),
  );

const COURTLISTENER_RAW_DECODE_FAILURE = {
  WRONG_MEDIA_TYPE: "wrong-media-type",
  NOT_AN_ENVELOPE: "not-an-envelope",
  MISSING_PART: "missing-part",
  UNEXPECTED_PART: "unexpected-part",
  MALFORMED_PART: "malformed-part",
  UNSUPPORTED_VERSION: "unsupported-version",
} as const;

class CourtListenerRawDecodeError extends TaggedError(
  "CourtListenerRawDecodeError",
)<{
  message: string;
  reason: (typeof COURTLISTENER_RAW_DECODE_FAILURE)[keyof typeof COURTLISTENER_RAW_DECODE_FAILURE];
  part: string | null;
}> {}

const decodeFailure = (
  reason: CourtListenerRawDecodeError["reason"],
  part: string | null = null,
) =>
  Result.err(
    new CourtListenerRawDecodeError({
      message: `CourtListener raw envelope unreadable: ${reason}`,
      reason,
      part,
    }),
  );

const parsePart = (text: string | undefined): unknown =>
  Result.try({
    try: (): unknown => JSON.parse(text ?? ""),
    catch: () => undefined,
  }).unwrapOr(undefined);

type DecodeCourtListenerRawOptions = {
  readonly raw: string;
  readonly contentType: string;
};

/**
 * The record a stored envelope holds, still unvalidated: a reparse admits it
 * through the same checks as a fresh record.
 */
export const decodeCourtListenerRaw = ({
  contentType,
  raw,
}: DecodeCourtListenerRawOptions): Result<
  unknown,
  CourtListenerRawDecodeError
> => {
  const parts =
    contentType === SOURCE_RAW_ENVELOPE_CONTENT_TYPE
      ? decodeSourceRawEnvelope(raw)
      : null;
  if (parts === null) {
    return decodeFailure(
      contentType === SOURCE_RAW_ENVELOPE_CONTENT_TYPE
        ? COURTLISTENER_RAW_DECODE_FAILURE.NOT_AN_ENVELOPE
        : COURTLISTENER_RAW_DECODE_FAILURE.WRONG_MEDIA_TYPE,
    );
  }
  // An undeclared part name is publisher-controlled; it is not echoed back.
  if (Object.keys(parts).some((name) => !PART_NAMES.has(name))) {
    return decodeFailure(COURTLISTENER_RAW_DECODE_FAILURE.UNEXPECTED_PART);
  }
  const missing = [...PART_NAMES].find((name) => parts[name] === undefined);
  if (missing !== undefined) {
    return decodeFailure(
      COURTLISTENER_RAW_DECODE_FAILURE.MISSING_PART,
      missing,
    );
  }
  const malformed = Object.entries(parts).find(
    ([, text]) => parsePart(text) === undefined,
  );
  if (malformed !== undefined) {
    return decodeFailure(
      COURTLISTENER_RAW_DECODE_FAILURE.MALFORMED_PART,
      malformed[0],
    );
  }
  const contract = parsePart(parts[COURTLISTENER_RAW_PART.CONTRACT]);
  if (
    !isRecord(contract) ||
    Object.keys(contract).length !== 2 ||
    contract["version"] !== COURTLISTENER_RECORD_VERSION
  ) {
    return decodeFailure(
      COURTLISTENER_RAW_DECODE_FAILURE.UNSUPPORTED_VERSION,
      COURTLISTENER_RAW_PART.CONTRACT,
    );
  }
  return Result.ok({
    version: contract["version"],
    provenance: contract["provenance"],
    ...Object.fromEntries(
      Object.entries(TABLE_PARTS).map(
        ([part, key]) => [key, parsePart(parts[part])] as const,
      ),
    ),
  });
};
