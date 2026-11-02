import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";

// A cursor part is `string | number | boolean | null`. JSON is the wire
// format, so exclude the values JSON cannot round-trip: NaN/Infinity (which
// `JSON.stringify` turns into `null`) and the signed zero `-0` (which JSON has
// no notation for, so it comes back as `0`).
const cursorPrimitive = fc.oneof(
  fc.string(),
  fc.integer(),
  fc
    .double({ noNaN: true, noDefaultInfinity: true })
    .map((n) => (Object.is(n, -0) ? 0 : n)),
  fc.boolean(),
  fc.constant(null),
);

describe("pagination cursor codec (properties)", () => {
  test("decode ∘ encode is the identity on cursor-part arrays", () => {
    assertProperty(
      "decode ∘ encode is the identity on cursor-part arrays",
      fc.property(fc.array(cursorPrimitive), (parts) => {
        expect(decodePaginationCursor(encodePaginationCursor(parts))).toEqual(
          parts,
        );
      }),
      { numRuns: 500 },
    );
  });

  test("decode never throws and yields an array or null for any string", () => {
    assertProperty(
      "decode never throws and yields an array or null for any string",
      fc.property(fc.string(), (raw) => {
        const decoded = decodePaginationCursor(raw);
        expect(decoded === null || Array.isArray(decoded)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  test("a well-formed but non-array payload decodes to null", () => {
    const nonArray = fc.oneof(
      fc.string(),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.dictionary(fc.string(), fc.string()),
    );
    assertProperty(
      "a well-formed but non-array payload decodes to null",
      fc.property(nonArray, (value) => {
        const encoded = Buffer.from(JSON.stringify(value)).toBase64({
          alphabet: "base64url",
          omitPadding: true,
        });
        expect(decodePaginationCursor(encoded)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});
