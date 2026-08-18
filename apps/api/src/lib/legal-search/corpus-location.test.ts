import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  formatCorpusLocation,
  isPackedLocation,
  parseCorpusLocation,
} from "@/api/lib/legal-search/corpus-location";
import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import { packKey } from "@/api/lib/legal-search/corpus-pack";

// The row's key column is varchar(512); an address that does not fit is
// unrepresentable, so the grammar is checked against that ceiling.
const KEY_COLUMN_MAX_CHARS = 512;

const jurisdiction = fc.stringMatching(/^[A-Z]{2,4}$/u);

// UUIDv7 text: what `newCorpusPackId` produces.
const packId = fc.uuid({ version: 7 });

const packedLocation: fc.Arbitrary<PackedCorpusLocation> = fc
  .record({
    jurisdiction,
    packId,
    offset: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
    length: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
  })
  .map(({ jurisdiction: j, packId: id, offset, length }) => ({
    type: "packed",
    packKey: packKey({ jurisdiction: j, packId: id }),
    offset,
    length,
  }));

describe("corpus location grammar", () => {
  test("format then parse is the identity over packed addresses", () => {
    fc.assert(
      fc.property(packedLocation, (location) => {
        const address = formatCorpusLocation(location);
        expect(parseCorpusLocation(address)).toEqual(location);
        expect(address.length).toBeLessThan(KEY_COLUMN_MAX_CHARS);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("a value without the pack prefix is a plain object key", () => {
    const key = "legal-corpus/documents/jurisdiction=SVK/doc/hash/text.zst";
    const location = parseCorpusLocation(key);

    expect(location).toEqual({ type: "object", key });
    expect(isPackedLocation(location)).toBe(false);
    expect(formatCorpusLocation(location)).toBe(key);
  });

  test("a pack key containing the address separators still round-trips", () => {
    // `@` and `+` are legal in object keys; the anchored digit groups at
    // the end decide where the address suffix begins.
    const location: PackedCorpusLocation = {
      type: "packed",
      packKey: "legal-corpus/packs/jurisdiction=CZE/a@b+c.pack",
      offset: 7,
      length: 9,
    };

    expect(parseCorpusLocation(formatCorpusLocation(location))).toEqual(
      location,
    );
  });

  test("a value with the pack prefix that breaks the grammar panics", () => {
    for (const malformed of [
      "pack:",
      "pack:legal-corpus/packs/x.pack",
      "pack:legal-corpus/packs/x.pack@12",
      "pack:legal-corpus/packs/x.pack@-1+4",
      "pack:legal-corpus/packs/x.pack@1+4.5",
      "pack:@1+4",
    ]) {
      expect(() => parseCorpusLocation(malformed)).toThrow(
        "Malformed packed corpus address",
      );
    }
  });

  test("an integer beyond the safe range panics", () => {
    expect(() =>
      parseCorpusLocation("pack:legal-corpus/packs/x.pack@9007199254740993+1"),
    ).toThrow("unrepresentable integer");
  });
});
