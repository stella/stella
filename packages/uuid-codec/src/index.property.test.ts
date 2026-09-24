/**
 * Properties over the whole input class, not the uuid versions that happen to
 * be in the corpus today: a route segment is minted from an id and resolved
 * back somewhere else, so the two halves have to agree for every id, and a
 * segment that is not one must say so rather than resolve to a wrong row.
 */

import { Result } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import {
  decodeCompactUuid,
  decodeUuidSuffix,
  encodeCompactUuid,
} from "./index";

setDefaultTimeout(propertyTestTimeout(20_000));

const COMPACT_UUID_LENGTH = 22;

const hex = (byte: number): string => byte.toString(16).padStart(2, "0");

// Every 16-byte value, not only the versions in use: the codec carries bytes
// and must not acquire an opinion about the version or variant nibbles.
const uuidArbitrary = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((bytes) => {
    const digits = Array.from(bytes, hex).join("");
    return [
      digits.slice(0, 8),
      digits.slice(8, 12),
      digits.slice(12, 16),
      digits.slice(16, 20),
      digits.slice(20),
    ].join("-");
  });

// The generator's input space, not a mirror of the codec's own table: a
// character it stopped accepting would land in the decode-fails branch below.
const BASE64URL_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");

const compactSegmentArbitrary = fc
  .array(fc.constantFrom(...BASE64URL_CHARS), {
    minLength: COMPACT_UUID_LENGTH,
    maxLength: COMPACT_UUID_LENGTH,
  })
  .map((chars) => chars.join(""));

describe("compact uuid properties", () => {
  test("a compacted uuid decodes back to the uuid it was minted from", () => {
    fc.assert(
      fc.property(uuidArbitrary, (uuid) => {
        const encoded = Result.unwrap(encodeCompactUuid(uuid));
        expect(encoded).toHaveLength(COMPACT_UUID_LENGTH);
        expect(Result.unwrap(decodeCompactUuid(encoded))).toBe(uuid);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("decoding a uuid written out in full is a fixed point", () => {
    fc.assert(
      fc.property(uuidArbitrary, (uuid) => {
        expect(Result.unwrap(decodeCompactUuid(uuid))).toBe(uuid);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a value that is neither spelling is reported, never thrown", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const decoded = decodeCompactUuid(value);
        if (Result.isError(decoded)) {
          expect(decoded.error._tag).toBe("InvalidCompactUuidError");
          return;
        }
        // Anything that decodes was already one of the two spellings, so
        // re-encoding it reaches the segment it came from.
        const reencoded = Result.unwrap(encodeCompactUuid(decoded.value));
        expect(Result.unwrap(decodeCompactUuid(reencoded))).toBe(decoded.value);
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("a compact segment that decodes is the one the encoder would mint", () => {
    // One id, one address. A segment whose bytes are an id's but whose four
    // unused trailing bits are set is not a second spelling of that id: it
    // does not decode at all, so a row is never reachable sixteen ways.
    fc.assert(
      fc.property(compactSegmentArbitrary, (segment) => {
        const decoded = decodeCompactUuid(segment);
        if (Result.isError(decoded)) {
          return;
        }
        expect(Result.unwrap(encodeCompactUuid(decoded.value))).toBe(segment);
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("a uuid the encoder rejects is not a uuid", () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const encoded = encodeCompactUuid(value);
        if (Result.isError(encoded)) {
          expect(encoded.error._tag).toBe("InvalidUuidError");
          expect(encoded.error.value).toBe(value);
          return;
        }
        expect(Result.unwrap(decodeCompactUuid(encoded.value))).toBe(
          value.toLowerCase(),
        );
      }),
      propertyConfig({ numRuns: 500 }),
    );
  });

  test("a suffixed uuid reads back whatever the prefix and compact spelling", () => {
    // The separator is drawn from the base64url alphabet on purpose: a
    // compact id starting with or containing it must not move the split.
    fc.assert(
      fc.property(
        uuidArbitrary,
        fc.string(),
        fc.constantFrom("--", "-", "_"),
        fc.boolean(),
        (uuid, prefix, separator, compact) => {
          const tail = compact ? Result.unwrap(encodeCompactUuid(uuid)) : uuid;
          const decoded = decodeUuidSuffix({
            segment: `${prefix}${separator}${tail}`,
            separator,
          });
          expect(Result.unwrap(decoded)).toBe(uuid);
        },
      ),
      propertyConfig({ numRuns: 500 }),
    );
  });
});
