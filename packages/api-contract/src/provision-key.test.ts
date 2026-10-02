import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { CASE_LAW_JURISDICTIONS } from "./case-law-jurisdictions";
import { formatProvisionKey, parseProvisionKey } from "./provision-key";
import type { ProvisionRef } from "./provision-key";

const key = {
  jurisdiction: "CZE",
  workIdentifier: "89/2012 Sb.",
  anchor: "par_5-odst_2",
} as const;
const text = fc
  .array(fc.integer({ min: 0, max: 0x10_ff_ff }), {
    minLength: 1,
    maxLength: 40,
  })
  .map((points) => String.fromCodePoint(...points));

describe("provision keys", () => {
  test("provision keys round-trip every jurisdiction and Unicode component", () => {
    assertProperty(
      "provision keys round-trip every jurisdiction and Unicode component",
      fc.property(
        fc.record({
          jurisdiction: fc.constantFrom(...CASE_LAW_JURISDICTIONS),
          workIdentifier: text,
          anchor: text,
        }),
        (value) => {
          const formatted = formatProvisionKey(value);
          expect(parseProvisionKey(formatted)).toEqual(value);
          const parsed = parseProvisionKey(formatted);
          if (parsed !== null) {
            expect(formatProvisionKey(parsed)).toBe(formatted);
          }
        },
      ),
    );
  });

  test("ELI discovery and citation scope do not change identity", () => {
    const reference = {
      unit: "section",
      section: 5,
      sectionSuffix: null,
      subsection: "2",
      letter: null,
      point: null,
      sentence: null,
      openEnded: false,
    } as const;
    const ref = {
      ...key,
      work: { identifier: key.workIdentifier, eli: null },
      reference,
    } satisfies ProvisionRef;
    expect(formatProvisionKey(ref)).toBe(
      '["CZE","89/2012 Sb.","par_5-odst_2"]',
    );
    const withMetadata = {
      ...ref,
      work: {
        identifier: key.workIdentifier,
        eli: "https://www.e-sbirka.cz/eli/cz/sb/2012/89",
      },
      reference: { ...reference, sentence: "3", openEnded: true },
    } satisfies ProvisionRef;
    expect(formatProvisionKey(withMetadata)).toBe(formatProvisionKey(ref));
  });

  test.each([
    "not json",
    "null",
    "{}",
    '["CZE","89/2012 Sb."]',
    '["CZE","89/2012 Sb.","par_5","2026-01-01"]',
    '["XXX","89/2012 Sb.","par_5"]',
    '["CZE","","par_5"]',
    '["CZE","89/2012 Sb.",""]',
    '["CZE",89,"par_5"]',
    '[ "CZE", "89/2012 Sb.", "par_5" ]',
  ])("rejects malformed or noncanonical key %s", (raw) => {
    expect(parseProvisionKey(raw)).toBeNull();
  });

  test("formatting rejects empty identity components", () => {
    expect(() => formatProvisionKey({ ...key, anchor: "" })).toThrow(
      "Invalid provision key",
    );
    expect(() => formatProvisionKey({ ...key, workIdentifier: "" })).toThrow(
      "Invalid provision key",
    );
  });

  test("delimiters cannot alias another tuple", () => {
    expect(
      formatProvisionKey({ ...key, workIdentifier: "a|b", anchor: "c" }),
    ).not.toBe(
      formatProvisionKey({ ...key, workIdentifier: "a", anchor: "b|c" }),
    );
  });
});
