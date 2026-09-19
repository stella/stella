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
