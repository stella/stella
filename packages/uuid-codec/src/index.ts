/**
 * A uuid, compacted for a URL segment.
 *
 * A public-law address carries a row id when the corpus holds no slug for the
 * row yet. Written out, a uuid spends 36 characters on a segment nobody reads;
 * its 16 bytes in base64url spend 22 and survive a copy-paste, a mail client's
 * line wrap, and a redirect. The encoding is unpadded and fixed-length, so a
 * segment either is one of these or is not, with nothing to guess.
 *
 * The alphabet arithmetic is hand-rolled rather than routed through `Buffer` or
 * `atob`: the encoding is part of published URLs, both readers run in the
 * browser as well as on the server, and a byte-for-byte stable output is what
 * keeps yesterday's links resolving.
 */

import { Result, TaggedError, type TaggedErrorClass } from "better-result";

/**
 * The uuid shape as a pattern source, for a schema builder that takes one.
 * Explicit hex ranges rather than the `i` flag, because a builder consumes
 * `.source` and the flags do not travel with it.
 */
export const UUID_PATTERN =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const UUID_REGEX = new RegExp(UUID_PATTERN, "u");
const COMPACT_UUID_LENGTH = 22;
const UUID_LENGTH = 36;
const COMPACT_UUID_REGEX = new RegExp(
  `^[A-Za-z0-9_-]{${COMPACT_UUID_LENGTH}}$`,
  "u",
);
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const InvalidUuidErrorBase: TaggedErrorClass<"InvalidUuidError"> =
  TaggedError("InvalidUuidError");

/** The value handed to {@link encodeCompactUuid} was not a uuid. */
export class InvalidUuidError extends InvalidUuidErrorBase<{
  message: string;
  value: string;
}> {
  constructor(value: string) {
    super({ message: `${JSON.stringify(value)} is not a uuid`, value });
  }
}

const InvalidCompactUuidErrorBase: TaggedErrorClass<"InvalidCompactUuidError"> =
  TaggedError("InvalidCompactUuidError");

/** The segment handed to {@link decodeCompactUuid} carried neither spelling. */
export class InvalidCompactUuidError extends InvalidCompactUuidErrorBase<{
  message: string;
  value: string;
}> {
  constructor(value: string) {
    super({
      message: `${JSON.stringify(value)} is neither a compacted uuid nor a uuid`,
      value,
    });
  }
}

/** Whether a value is a uuid written out in full. */
export const isUuid = (value: string): boolean => UUID_REGEX.test(value);

const uuidToBytes = (uuid: string): number[] => {
  const hex = uuid.replaceAll("-", "").toLowerCase();
  const bytes: number[] = [];
  for (let index = 0; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }

  return bytes;
};

const bytesToUuid = (bytes: readonly number[]): string => {
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const encodeBase64Url = (bytes: readonly number[]): string => {
  let encoded = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const remaining = bytes.length - index;
    const triplet = first * 65_536 + second * 256 + third;

    encoded += BASE64URL_ALPHABET[Math.floor(triplet / 262_144) % 64] ?? "";
    encoded += BASE64URL_ALPHABET[Math.floor(triplet / 4096) % 64] ?? "";
    if (remaining > 1) {
      encoded += BASE64URL_ALPHABET[Math.floor(triplet / 64) % 64] ?? "";
    }
    if (remaining > 2) {
      encoded += BASE64URL_ALPHABET[triplet % 64] ?? "";
    }
  }

  return encoded;
};

/**
 * 22 base64url characters carry 132 bits and a uuid is 128, so the last
 * character has four bits the encoder always writes as zero. A segment whose
 * residual is not zero is not one this codec minted: accepting it would give
 * every id sixteen spellings, and sixteen addresses for one row.
 */
const decodeBase64Url = (value: string): number[] | null => {
  const bytes: number[] = [];
  let buffer = 0;
  let bitCount = 0;

  for (const char of value) {
    const sixBits = BASE64URL_ALPHABET.indexOf(char);
    if (sixBits === -1) {
      return null;
    }

    buffer = buffer * 64 + sixBits;
    bitCount += 6;

    while (bitCount >= 8) {
      bitCount -= 8;
      const divisor = 2 ** bitCount;
      bytes.push(Math.floor(buffer / divisor) % 256);
      buffer %= divisor;
    }
  }

  return bytes.length === 16 && buffer === 0 ? bytes : null;
};

/** A uuid's 16 bytes as 22 base64url characters. */
export const encodeCompactUuid = (
  uuid: string,
): Result<string, InvalidUuidError> =>
  isUuid(uuid)
    ? Result.ok(encodeBase64Url(uuidToBytes(uuid)))
    : Result.err(new InvalidUuidError(uuid));

/**
 * The uuid a segment carries, lower-cased, from either spelling: the 22
 * character compact form, or a uuid written out in full. Both are accepted
 * because a segment can also be hand-typed or come from an older link.
 *
 * One compact spelling per id: a segment that decodes to the right bytes but
 * is not what {@link encodeCompactUuid} would mint is rejected.
 */
export const decodeCompactUuid = (
  segment: string,
): Result<string, InvalidCompactUuidError> => {
  if (isUuid(segment)) {
    return Result.ok(segment.toLowerCase());
  }

  const bytes = COMPACT_UUID_REGEX.test(segment)
    ? decodeBase64Url(segment)
    : null;

  return bytes === null
    ? Result.err(new InvalidCompactUuidError(segment))
    : Result.ok(bytesToUuid(bytes));
};

type DecodeUuidSuffixOptions = {
  segment: string;
  /** What the route puts between its readable prefix and the id. */
  separator: string;
};

/**
 * The uuid a `<prefix><separator><uuid>` segment ends with, in either
 * spelling. Split on the fixed-length tail, never on the separator: the
 * base64url alphabet contains `-`, so a compact uuid can start with or
 * contain the separator itself.
 */
export const decodeUuidSuffix = ({
  segment,
  separator,
}: DecodeUuidSuffixOptions): Result<string, InvalidCompactUuidError> => {
  for (const tailLength of [COMPACT_UUID_LENGTH, UUID_LENGTH]) {
    const tailStart = segment.length - tailLength;
    const separatorStart = tailStart - separator.length;
    if (
      separatorStart < 0 ||
      segment.slice(separatorStart, tailStart) !== separator
    ) {
      continue;
    }

    const decoded = decodeCompactUuid(segment.slice(tailStart));
    if (Result.isOk(decoded)) {
      return decoded;
    }
  }

  return Result.err(new InvalidCompactUuidError(segment));
};
