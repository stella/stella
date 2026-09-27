import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import { isAbsentPlaceholder } from "./absent";
import { isSentinelUuid, normalizeUuid, SENTINEL_UUIDS } from "./uuid";

/** Every spelling a copied id arrives in, each naming the same 128 bits. */
const SPELLINGS = [
  (id: string) => id.toUpperCase(),
  (id: string) => `{${id}}`,
  (id: string) => `urn:uuid:${id}`,
  (id: string) => id.replaceAll("-", ""),
  (id: string) => ` ${id}\t`,
  (id: string) => `{${id.replaceAll("-", "").toUpperCase()}}`,
] as const;

const repeatedDigitArb = fc.constantFrom(..."0123456789abcdef").map((digit) => {
  const hex = digit.repeat(32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

const sentinelArb = fc.oneof(
  fc.constantFrom(...SENTINEL_UUIDS),
  repeatedDigitArb,
);

describe("record ids", () => {
  test("a real id round-trips unchanged, with nothing to report", () => {
    fc.assert(
      fc.property(fc.uuid(), (id) => {
        fc.pre(!isSentinelUuid(id));
        expect(normalizeUuid(id)).toEqual({ ok: true, value: id });
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("every spelling of a real id reads back to the canonical id", () => {
    fc.assert(
      fc.property(fc.uuid(), fc.constantFrom(...SPELLINGS), (id, spell) => {
        fc.pre(!isSentinelUuid(id));
        const spelled = spell(id);
        const result = normalizeUuid(spelled);
        expect(result.ok === true && result.value).toBe(id);
        // Uppercasing an id with no letter in it (fast-check favours such
        // ids) spells the canonical form, which is taken without a note.
        expect(result.ok === true && result.note !== undefined).toBe(
          spelled !== id,
        );
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });

  test("an invented id is no value in every spelling", () => {
    fc.assert(
      fc.property(sentinelArb, fc.constantFrom(...SPELLINGS), (id, spell) => {
        expect(normalizeUuid(spell(id)).ok).toBe("absent");
        expect(normalizeUuid(id).ok).toBe("absent");
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("a string that is not a uuid asks", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (text) => {
        fc.pre(
          !/^[\s{]*(?:urn:uuid:)?[0-9a-f-]{32,36}\}?\s*$/iu.test(text) &&
            !isAbsentPlaceholder(text),
        );
        expect(normalizeUuid(text).ok).toBe(false);
      }),
      propertyConfig({ numRuns: 300 }),
    );
  });
});
