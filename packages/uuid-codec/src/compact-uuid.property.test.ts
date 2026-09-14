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

import { decodeCompactUuid, encodeCompactUuid } from "./compact-uuid";

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
        // The only strings that decode are the two spellings of a uuid, and
        // re-encoding what came back has to reach the same 22 characters.
        const reencoded = Result.unwrap(encodeCompactUuid(decoded.value));
        expect(Result.unwrap(decodeCompactUuid(reencoded))).toBe(decoded.value);
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
});
