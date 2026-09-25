import { Result } from "better-result";

/**
 * The character sets text is mis-decoded between, each with an exact
 * encoder and a fatal decoder.
 *
 * Every single-byte table is derived from the platform's WHATWG decoder by
 * decoding the 256 byte values, so encoding is the decoder's inverse by
 * construction and no mapping is written by hand. `iso-8859-1` is the one
 * exception: WHATWG decodes that label as windows-1252, while the tools that
 * mis-decode text as "Latin-1" (Java, Python, PDF extractors) map every byte
 * to the code point of the same value, C1 controls included. That identity is
 * what it means here.
 */

export const CHARSETS = [
  "utf-8",
  "windows-1250",
  "windows-1251",
  "windows-1252",
  "windows-1253",
  "windows-1257",
  "iso-8859-1",
  "iso-8859-2",
  "iso-8859-7",
  "iso-8859-13",
] as const;

export type Charset = (typeof CHARSETS)[number];

type SingleByteCharset = Exclude<Charset, "utf-8">;

type SingleByteTable = {
  /** Byte value → code point, or null where the charset leaves the byte undefined. */
  decode: readonly (number | null)[];
  encode: ReadonlyMap<number, number>;
};

const latin1Table = (): SingleByteTable => {
  const decode = Array.from({ length: 256 }, (_, byte) => byte);
  return { decode, encode: new Map(decode.map((cp, byte) => [cp, byte])) };
};

const whatwgTable = (
  label: Exclude<SingleByteCharset, "iso-8859-1">,
): SingleByteTable => {
  const decoder = new TextDecoder(label, { fatal: true });
  const decode: (number | null)[] = [];
  const encode = new Map<number, number>();
  for (let byte = 0; byte < 256; byte += 1) {
    // A fatal decoder throws on a byte the charset leaves undefined; that
    // is the table's answer for the byte, not a failure.
    const decoded = Result.try(
      () => decoder.decode(Uint8Array.of(byte)).codePointAt(0) ?? null,
    ).unwrapOr(null);
    decode.push(decoded);
    if (decoded !== null && !encode.has(decoded)) {
      encode.set(decoded, byte);
    }
  }
  return { decode, encode };
};

const tables = new Map<SingleByteCharset, SingleByteTable>();

const singleByteTable = (charset: SingleByteCharset): SingleByteTable => {
  const cached = tables.get(charset);
  if (cached !== undefined) {
    return cached;
  }
  const table = charset === "iso-8859-1" ? latin1Table() : whatwgTable(charset);
  tables.set(charset, table);
  return table;
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The bytes `text` is written as in `charset`, or null when it has no such bytes. */
export const encodeText = (
  text: string,
  charset: Charset,
): Uint8Array | null => {
  if (charset === "utf-8") {
    return utf8Encoder.encode(text);
  }
  const { encode } = singleByteTable(charset);
  const bytes = new Uint8Array(text.length);
  let length = 0;
  for (const char of text) {
    const byte = encode.get(char.codePointAt(0) ?? -1);
    if (byte === undefined) {
      return null;
    }
    bytes[length] = byte;
    length += 1;
  }
  return bytes.subarray(0, length);
};

/** Whether `charset` has a byte sequence for the code point. */
export const isEncodable = (codePoint: number, charset: Charset): boolean =>
  charset === "utf-8" || singleByteTable(charset).encode.has(codePoint);

/** `bytes` read as `charset`, or null when they are not valid in it. */
export const decodeBytes = (
  bytes: Uint8Array,
  charset: Charset,
): string | null => {
  if (charset === "utf-8") {
    // Invalid UTF-8 is an answer (these bytes were not UTF-8), not an error.
    return Result.try(() => utf8Decoder.decode(bytes)).unwrapOr(null);
  }
  const { decode } = singleByteTable(charset);
  let text = "";
  for (const byte of bytes) {
    const cp = decode[byte];
    if (cp === null || cp === undefined) {
      return null;
    }
    text += String.fromCodePoint(cp);
  }
  return text;
};

/** Text written in `actual` that was read as `assumed`. */
export type DecodingPair = { actual: Charset; assumed: Charset };

/**
 * What `text` said before it was read as `pair.assumed` instead of
 * `pair.actual`, or null when it cannot have been produced that way.
 */
export const undoMisdecoding = (
  text: string,
  pair: DecodingPair,
): string | null => {
  const bytes = encodeText(text, pair.assumed);
  return bytes === null ? null : decodeBytes(bytes, pair.actual);
};

/** `text` as it reads after being written in `actual` and read as `assumed`. */
export const misdecode = (text: string, pair: DecodingPair): string | null => {
  const bytes = encodeText(text, pair.actual);
  return bytes === null ? null : decodeBytes(bytes, pair.assumed);
};

/**
 * Every pair a text can be mis-decoded through reversibly: written in
 * UTF-8 or a single-byte set, read as a different single-byte set. Text read
 * as UTF-8 that was not UTF-8 loses its bytes to U+FFFD and cannot be undone,
 * so that direction is a signature, not a pair.
 */
export const DECODING_PAIRS: readonly DecodingPair[] = CHARSETS.flatMap(
  (actual) =>
    CHARSETS.filter((assumed) => assumed !== actual && assumed !== "utf-8").map(
      (assumed) => ({ actual, assumed }),
    ),
);
