import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  formatCorpusLocation,
  parseCorpusLocation,
} from "@/api/lib/legal-search/corpus-location";
import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  packKeyForMembers,
  corpusMemberDigest,
} from "@/api/lib/legal-search/corpus-pack";

// The row's key column is varchar(512); an address that does not fit is
// unrepresentable, so the grammar is checked against that ceiling.
const KEY_COLUMN_MAX_CHARS = 512;

const jurisdiction = fc.stringMatching(/^[A-Z]{2,4}$/u);

// Digests as the writer derives them, not as free-form hex: the address
// carries what `corpusMemberDigest` produced over a member's bytes.
const digest = fc
  .uint8Array({ minLength: 1, maxLength: 64 })
  .map(corpusMemberDigest);

const packedLocation: fc.Arbitrary<PackedCorpusLocation> = fc
  .record({
    jurisdiction,
    documentId: fc.uuid(),
    sha256: digest,
    offset: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
    length: fc.nat({ max: Number.MAX_SAFE_INTEGER }),
  })
  .map(({ jurisdiction: j, documentId, sha256, offset, length }) => ({
    type: "packed",
    packKey: packKeyForMembers({
      jurisdiction: j,
      members: [{ documentId, kind: "text", sha256, length: 1 }],
    }),
    offset,
    length,
    sha256,
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
    expect(formatCorpusLocation(location)).toBe(key);
  });

  test("a pack key containing the address separators still round-trips", () => {
    // `@`, `+` and `#` are legal in object keys; the anchored groups at the
    // end decide where the address suffix begins.
    const location: PackedCorpusLocation = {
      type: "packed",
      packKey: "legal-corpus/packs/jurisdiction=CZE/a@b+c#d.stlpack",
      offset: 7,
      length: 9,
      sha256: "c".repeat(64),
    };

    expect(parseCorpusLocation(formatCorpusLocation(location))).toEqual(
      location,
    );
  });

  test("a pack key ending in something digest-shaped keeps its own suffix", () => {
    // The key's trailing `#<64 hex>` is part of the key, not the member's
    // digest: the address the writer appends is what the parser must take.
    const location: PackedCorpusLocation = {
      type: "packed",
      packKey: `legal-corpus/packs/jurisdiction=CZE/x@1+2#${"a".repeat(64)}`,
      offset: 3,
      length: 4,
      sha256: "b".repeat(64),
    };

    expect(parseCorpusLocation(formatCorpusLocation(location))).toEqual(
      location,
    );
  });

  test("a value with the pack prefix that breaks the grammar panics", () => {
    const digestOf = "d".repeat(64);
    for (const malformed of [
      "pack:",
      "pack:legal-corpus/packs/x.stlpack",
      "pack:legal-corpus/packs/x.stlpack@12",
      `pack:legal-corpus/packs/x.stlpack@-1+4#${digestOf}`,
      `pack:legal-corpus/packs/x.stlpack@1+4.5#${digestOf}`,
      `pack:@1+4#${digestOf}`,
      // An address written before the digest became part of the grammar:
      // unverifiable, so it is refused rather than read.
      "pack:legal-corpus/packs/x.stlpack@1+4",
      // A digest of the wrong width, in the wrong case, or not hex at all
      // names bytes no reader could check the range against.
      `pack:legal-corpus/packs/x.stlpack@1+4#${"d".repeat(63)}`,
      `pack:legal-corpus/packs/x.stlpack@1+4#${"d".repeat(65)}`,
      `pack:legal-corpus/packs/x.stlpack@1+4#${"D".repeat(64)}`,
      `pack:legal-corpus/packs/x.stlpack@1+4#${"g".repeat(64)}`,
    ]) {
      expect(() => parseCorpusLocation(malformed)).toThrow(
        "Malformed packed corpus address",
      );
    }
  });

  test("an integer beyond the safe range panics", () => {
    expect(() =>
      parseCorpusLocation(
        `pack:legal-corpus/packs/x.stlpack@9007199254740993+1#${"a".repeat(64)}`,
      ),
    ).toThrow("unrepresentable integer");
  });
});
