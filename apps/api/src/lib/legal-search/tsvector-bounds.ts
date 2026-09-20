import { Result, UnhandledException } from "better-result";

import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

/**
 * Postgres stores a `tsvector` in at most 1 MiB and raises
 * `program_limit_exceeded` from `make_tsvector` for a value that does not fit.
 *
 * The ceiling is on the vector, not on the text behind it, and the two are only
 * loosely related: a lexeme is stored once with at most 256 positions, so a
 * multi-megabyte statute of ordinary prose collapses into a few kilobytes,
 * while text whose tokens are nearly all distinct (identifier tables, reference
 * lists, numbering) can project into more bytes than it occupies. Bounding
 * every document up front would therefore drop indexable text from the many to
 * protect against the few, so callers hand Postgres the whole text and bound
 * only a value it has already refused.
 *
 * Distinct four-character tokens are the densest projection measured, at 2.4
 * bytes of vector per byte of text, which leaves a bounded retry under two
 * thirds of the ceiling.
 */
const TSVECTOR_TEXT_MAX_BYTES = 256 * 1024;

// UTF-8 encodes every byte after the first of a character as 0b10xxxxxx, so a
// cut landing on one would split the character it belongs to.
const CONTINUATION_BYTE_FIRST = 0x80;
const CONTINUATION_BYTE_LAST = 0xbf;

const isContinuationByte = (byte: number | undefined): boolean =>
  byte !== undefined &&
  byte >= CONTINUATION_BYTE_FIRST &&
  byte <= CONTINUATION_BYTE_LAST;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * `text` shortened until its projection fits Postgres's `tsvector` ceiling.
 *
 * Cuts on a whitespace boundary so the tail is not indexed as a fragment of the
 * word it was taken from, and keeps the bounded prefix of a single token long
 * enough to fill the bound on its own.
 */
export const boundTsvectorText = (text: string): string => {
  const bytes = encoder.encode(text);
  if (bytes.length <= TSVECTOR_TEXT_MAX_BYTES) {
    return text;
  }

  let end = TSVECTOR_TEXT_MAX_BYTES;
  while (end > 0 && isContinuationByte(bytes[end])) {
    end -= 1;
  }

  const bounded = decoder.decode(bytes.subarray(0, end));
  const whole = bounded.replace(/\S+$/u, "").trimEnd();
  return whole === "" ? bounded : whole;
};

type TsvectorProjectionWrite =
  | { bounded: false }
  | {
      bounded: true;
      /** The prefix the row was written from, so the row and its vector agree. */
      indexedText: string;
      /** Postgres's refusal of the whole text, for the caller's log line. */
      cause: unknown;
    };

/**
 * Runs `write` over the whole text and, only once Postgres has refused that
 * projection for outgrowing the tsvector ceiling, once more over
 * {@link boundTsvectorText}. Any other failure propagates unchanged.
 *
 * A projection row with no row at all stays in its backfill's missing scan,
 * which reselects it on every pass, so landing a bounded row is what makes the
 * scan converge. `write` owns its transaction: the refused statement aborts the
 * one it ran in, and the retry needs a fresh one.
 */
export const writeProjectionWithinTsvectorCeiling = async (
  text: string,
  write: (indexedText: string) => Promise<void>,
): Promise<TsvectorProjectionWrite> => {
  const whole = await Result.tryPromise(async () => await write(text));
  if (Result.isOk(whole)) {
    return { bounded: false };
  }
  const cause =
    whole.error instanceof UnhandledException ? whole.error.cause : whole.error;
  if (!isPgError(cause, PG_ERROR.PROGRAM_LIMIT_EXCEEDED)) {
    throw cause;
  }
  const indexedText = boundTsvectorText(text);
  await write(indexedText);
  return { bounded: true, indexedText, cause };
};
