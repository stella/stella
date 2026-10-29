// parser-output-unchanged: [eu-ecj] envelope types moved to their owner with byte-identical parser output.
import { Result } from "better-result";

/**
 * Every response an adapter fetched for one decision, under the name it gives
 * each part.
 *
 * A source that serves a decision across several pages — a detail page beside
 * the document itself — has to store all of them or replay can only ever
 * recover what the parser already read. A field first captured later is then
 * unrecoverable for stored rows: the page that states it was fetched, parsed
 * for the fields of the day, and dropped.
 *
 * Parts are named by role rather than by URL: a replay asks for the detail
 * page, and which address served it is history.
 */
export type SourceRawParts = Readonly<Record<string, string>>;

/**
 * A binary response the envelope names instead of holding.
 *
 * `location` is an address in the form the corpus key columns already use
 * (`corpus-location.ts`): today always a plain object key, and a packed
 * address once these files are packed together, which is a change to where
 * the bytes are written and to nothing that reads this reference.
 *
 * `sha256` and `byteLength` are over the publisher's bytes, so a read can be
 * checked against what was stored rather than trusted for having arrived —
 * the check that matters once an address names a range inside an object
 * shared with other decisions.
 */
export type SourceRawObjectRef = {
  readonly location: string;
  readonly sha256: string;
  readonly contentType: string;
  readonly byteLength: number;
};

/** The binary responses of one envelope, under their part names. */
export type SourceRawObjects = Readonly<Record<string, SourceRawObjectRef>>;

/**
 * Media type for a multi-part raw payload, distinct from `application/json` so
 * a reader can tell an envelope from a publisher's own JSON document.
 */
export const SOURCE_RAW_ENVELOPE_CONTENT_TYPE =
  "application/vnd.stella.case-law-raw+json";

const SOURCE_RAW_ENVELOPE_VERSION = 1;

/**
 * Write an envelope over the text parts, and over the binary parts it names.
 *
 * `objects` is omitted rather than written empty when a decision has no
 * binary response, so the payload of an adapter that stores only text is
 * byte-identical to what it wrote before binaries existed.
 */
export const encodeSourceRawEnvelope = (
  parts: SourceRawParts,
  objects: SourceRawObjects = {},
): string =>
  JSON.stringify({
    version: SOURCE_RAW_ENVELOPE_VERSION,
    parts,
    ...(Object.keys(objects).length === 0 ? {} : { objects }),
  });

/**
 * The parts of a stored envelope, or `null` for a payload that is not one —
 * which is how a row stored before its adapter had an envelope reads, and why
 * every caller has to handle it rather than assume the shape it writes today.
 */
export const decodeSourceRawEnvelope = (raw: string): SourceRawParts | null => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== SOURCE_RAW_ENVELOPE_VERSION ||
    !("parts" in parsed) ||
    typeof parsed.parts !== "object" ||
    parsed.parts === null
  ) {
    return null;
  }

  const parts = Object.entries(parsed.parts);
  return parts.every(([, value]) => typeof value === "string")
    ? Object.fromEntries(parts.map(([name, value]) => [name, String(value)]))
    : null;
};

const isSourceRawObjectRef = (value: unknown): value is SourceRawObjectRef =>
  typeof value === "object" &&
  value !== null &&
  "location" in value &&
  typeof value.location === "string" &&
  "sha256" in value &&
  typeof value.sha256 === "string" &&
  "contentType" in value &&
  typeof value.contentType === "string" &&
  "byteLength" in value &&
  typeof value.byteLength === "number";

/**
 * The binary parts a stored envelope names, or `{}` for one that names none.
 *
 * Empty rather than null for every absence there is — not an envelope, an
 * envelope written before binaries, an `objects` map that does not read back
 * as references — because all of them mean the same thing to a caller: this
 * row states no binary response. A reader that had to tell them apart would
 * be deciding about the storage format rather than about the decision.
 */
export const decodeSourceRawEnvelopeObjects = (
  raw: string,
): SourceRawObjects => {
  const parsed = Result.try({
    try: (): unknown => JSON.parse(raw),
    catch: () => null,
  }).unwrapOr(null);

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== SOURCE_RAW_ENVELOPE_VERSION ||
    !("objects" in parsed) ||
    typeof parsed.objects !== "object" ||
    parsed.objects === null
  ) {
    return {};
  }

  const objects = Object.entries(parsed.objects);
  return objects.every(([, value]) => isSourceRawObjectRef(value))
    ? Object.fromEntries(objects)
    : {};
};

/**
 * Re-write a stored envelope with the addresses its binary parts were
 * written under.
 *
 * The adapter cannot name them: an address carries the corpus key the bytes
 * landed at, and the write happens in the pipeline. So the adapter states the
 * bytes and this closes the envelope over what storage answered.
 */
export const withSourceRawObjects = (
  raw: string,
  objects: SourceRawObjects,
): string => {
  const parts = decodeSourceRawEnvelope(raw);
  return parts === null ? raw : encodeSourceRawEnvelope(parts, objects);
};
