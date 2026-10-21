import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import { normalizeEuLegalIdentifier } from "./eu-legal-identity";
import {
  euProvisionSourceUrl,
  parseEuWorkIdentifier,
} from "./eu-provision-citations";

test("eu-publisher-identifier-normalization-is-a-suffix-preserving-fixed-point", () => {
  assertProperty(
    "eu-publisher-identifier-normalization-is-a-suffix-preserving-fixed-point",
    fc.property(
      fc.integer({ min: 1950, max: 2026 }),
      fc.integer({ min: 1, max: 9999 }),
      fc.constantFrom("", "(01)", "R(01)", "(01)R(02)"),
      fc.constantFrom("", "/oj", "/oj/eng", "/oj/eng/html", "/2024-01-01/eng"),
      (year, number, celexSuffix, eliSuffix) => {
        for (const letter of ["R", "L", "D", "S"]) {
          const identifier = `3${String(year)}${letter}${String(number).padStart(4, "0")}${celexSuffix}`;
          for (const spelling of [
            identifier,
            ` celex:${identifier.toLowerCase()} `,
            `https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=${encodeURIComponent(`CELEX:${identifier}`)}`,
          ]) {
            expect(normalizeEuLegalIdentifier(spelling)).toBe(identifier);
          }
          expect(
            normalizeEuLegalIdentifier(
              normalizeEuLegalIdentifier(identifier) ?? "",
            ),
          ).toBe(identifier);
        }
        for (const kind of ["reg", "dir", "dec"]) {
          for (const qualifier of ["", "_del", "_impl"]) {
            // Number qualifiers distinguish real legacy Euratom instruments.
            for (const numberSuffix of ["", "(1)", "(3)"]) {
              const path = `/eli/${kind}${qualifier}/${String(year)}/${String(number)}${numberSuffix}${eliSuffix}`;
              const identifier = `http://data.europa.eu${path}`;
              for (const publisher of [
                "http://data.europa.eu",
                "https://data.europa.eu",
                "https://eur-lex.europa.eu",
              ]) {
                expect(normalizeEuLegalIdentifier(`${publisher}${path}`)).toBe(
                  identifier,
                );
                expect(
                  normalizeEuLegalIdentifier(
                    `${publisher}${path.replaceAll("(", "%28").replaceAll(")", "%29")}`,
                  ),
                ).toBe(identifier);
              }
              expect(normalizeEuLegalIdentifier(identifier)).toBe(identifier);
            }
          }
        }
      },
    ),
  );
});

test("publisher identity does not collapse corrigenda, versions or legacy number qualifiers", () => {
  const identifiers = [
    "31962R0031",
    "31962R0031(01)",
    "31962R0031R(01)",
    "01962R0031-20140501",
    "31998S2496",
    "http://data.europa.eu/eli/reg/1962/31(1)/oj",
    "http://data.europa.eu/eli/reg/1962/31(1)/2014-05-01/eng",
    "http://data.europa.eu/eli/reg/1962/11(3)/oj",
  ];
  expect(identifiers.map(normalizeEuLegalIdentifier)).toEqual(identifiers);
  expect(new Set(identifiers.map(normalizeEuLegalIdentifier)).size).toBe(
    identifiers.length,
  );
});

test("provision work parsing consumes normalized publisher CELEX identifiers", () => {
  const work = parseEuWorkIdentifier(" celex:32016r0679 ");
  expect(work).toMatchObject({
    celex: "32016R0679",
    kind: "regulation",
    year: 2016,
    number: 679,
  });
  expect(euProvisionSourceUrl(" celex:32016r0679 ")).toBe(
    "https://eur-lex.europa.eu/legal-content/AUTO/?uri=CELEX:32016R0679",
  );
});

test("unrecognized publishers and malformed identity suffixes are refused", () => {
  for (const identifier of [
    "32016Q0679",
    "32016R0679garbage",
    "32016R0679R(01)R(02)",
    "https://example.com/eli/reg/2016/679/oj",
    "https://data.europa.eu.evil.test/eli/reg/2016/679/oj",
    "https://name@data.europa.eu/eli/reg/2016/679/oj",
    "https://data.europa.eu:444/eli/reg/2016/679/oj",
    "https://data.europa.eu/eli/reg_other/2016/679/oj",
    "https://data.europa.eu/eli/reg/2016/0/oj",
    "https://data.europa.eu/eli/reg/2016/679/oj?different=work",
    "https://data.europa.eu/eli/reg/2016/679/oj#article_1",
    "https://data.europa.eu/eli/reg/2016/679%2Fevil%3F/oj",
    "https://data.europa.eu/eli/reg/2016/6\n79/oj",
  ]) {
    expect(normalizeEuLegalIdentifier(identifier)).toBeNull();
  }
});

test("eu-publisher-identities-reject-ambiguous-url-boundaries", () => {
  assertProperty(
    "eu-publisher-identities-reject-ambiguous-url-boundaries",
    fc.property(
      fc.integer({ min: 1950, max: 2026 }),
      fc.integer({ min: 1, max: 9998 }),
      (year, number) => {
        for (const separator of ["%2f", "%2F", "%5c", "%5C"]) {
          expect(
            normalizeEuLegalIdentifier(
              `https://data.europa.eu/eli/reg/${String(year)}/${String(number)}${separator}oj`,
            ),
          ).toBeNull();
        }
        const first = `CELEX:3${String(year)}R${String(number).padStart(4, "0")}`;
        const second = `CELEX:3${String(year)}R${String(number + 1).padStart(4, "0")}`;
        expect(first).not.toBe(second);
        const url = "https://eur-lex.europa.eu/legal-content/EN/TXT/";
        for (const [left, right] of [
          [first, second],
          [second, first],
        ] as const) {
          expect(
            normalizeEuLegalIdentifier(
              `${url}?uri=${encodeURIComponent(left)}&uri=${encodeURIComponent(right)}`,
            ),
          ).toBeNull();
        }
        expect(
          normalizeEuLegalIdentifier(
            `${url}?uri=${encodeURIComponent(first)}&uri=${encodeURIComponent(first.toLowerCase())}`,
          ),
        ).toBe(first.slice("CELEX:".length));
      },
    ),
  );
});
