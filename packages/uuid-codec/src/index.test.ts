import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { decodeCompactUuid, encodeCompactUuid, isUuid } from "./index";

// The pair the public case-law and statute URLs already carry: a change that
// alters the encoding breaks every link minted before it.
const UUID = "019dd47d-f507-7c84-b827-980af11b8980";
const COMPACT_UUID = "AZ3UffUHfIS4J5gK8RuJgA";

describe("compact uuid", () => {
  test("compacts a uuid to the 22 characters published links carry", () => {
    expect(Result.unwrap(encodeCompactUuid(UUID))).toBe(COMPACT_UUID);
    expect(Result.unwrap(decodeCompactUuid(COMPACT_UUID))).toBe(UUID);
  });

  test("reads a uuid written out in full, in either case", () => {
    expect(Result.unwrap(decodeCompactUuid(UUID.toUpperCase()))).toBe(UUID);
    expect(Result.unwrap(encodeCompactUuid(UUID.toUpperCase()))).toBe(
      COMPACT_UUID,
    );
  });

  test("reports a value that is not a uuid rather than throwing", () => {
    const encoded = encodeCompactUuid("20 Cdo 470/2017");
    expect(Result.isError(encoded)).toBe(true);
    if (Result.isError(encoded)) {
      expect(encoded.error._tag).toBe("InvalidUuidError");
      expect(encoded.error.value).toBe("20 Cdo 470/2017");
    }
  });

  test("reports a segment that is neither spelling rather than throwing", () => {
    // A slug, the compact form a character short, the right length with a
    // character outside the alphabet, and nothing at all.
    for (const segment of [
      "20-cdo-470-2017",
      "AZ3UffUHfIS4J5gK8RuJg",
      "AZ3UffUHfIS4J5gK8RuJg+",
      "",
    ]) {
      const decoded = decodeCompactUuid(segment);
      expect(Result.isError(decoded)).toBe(true);
      if (Result.isError(decoded)) {
        expect(decoded.error._tag).toBe("InvalidCompactUuidError");
      }
    }
  });

  test("rejects a segment carrying bits the encoder never writes", () => {
    // Same 16 bytes, last character's four unused bits set: one id must have
    // one compact address, not sixteen.
    const withResidual = `${COMPACT_UUID.slice(0, -1)}B`;
    expect(Result.unwrap(decodeCompactUuid(COMPACT_UUID))).toBe(UUID);
    expect(Result.isError(decodeCompactUuid(withResidual))).toBe(true);
  });

  test("distinguishes a uuid from a citation", () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid("20 Cdo 470/2017")).toBe(false);
  });
});
