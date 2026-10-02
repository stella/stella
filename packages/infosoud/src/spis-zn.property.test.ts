import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  assertProperty,
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { NS_CASE_TYPES } from "./constants.js";
import { InfoSoudParseError } from "./errors.js";
import {
  formatSpisZnCanonical,
  formatSpisZnCompact,
  parseSpisZn,
  splitSpisZnAndCourtQuery,
  toInfoSoudRequestBody,
} from "./spis-zn.js";

const caseNumber = fc.record({
  cisloSenatu: fc.integer({ min: 1, max: 999 }),
  druhVeci: fc.constantFrom("T", "C", "Cdo", "Tdo", "ICdo", "Co", "Nc"),
  bcVec: fc.integer({ min: 1, max: 999_999 }),
  rocnik: fc.integer({ min: 1000, max: 9999 }),
});
const spacing = fc.constantFrom(" ", "  ", "\t", "\n", "\u00a0", "\u202f");

test(
  "case-number spellings retain their canonical identity",
  () => {
    fc.assert(
      fc.property(
        caseNumber,
        spacing,
        fc.constantFrom("/", "_", " "),
        (parts, gap, separator) => {
          const canonical = formatSpisZnCanonical(parts);
          const parsed = parseSpisZn(canonical);
          expect(parsed).toMatchObject({
            ...parts,
            druhVeci: parts.druhVeci.toUpperCase(),
          });
          const spelling = `${gap}${parts.cisloSenatu}${gap}${parts.druhVeci.toLowerCase()}${gap}${parts.bcVec}${separator}${gap}${parts.rocnik}${gap}`;
          expect(parseSpisZn(spelling)).toEqual(parsed);
          expect(parseSpisZn(formatSpisZnCanonical(parsed))).toEqual(parsed);
          expect(parseSpisZn(formatSpisZnCompact(parsed))).toEqual(parsed);
          expect(
            formatSpisZnCanonical(parseSpisZn(formatSpisZnCanonical(parsed))),
          ).toBe(formatSpisZnCanonical(parsed));
        },
      ),
      propertyConfig({ seed: propertySeed() }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "explicit courts override register inference and route all case fields",
  () => {
    assertProperty(
      "explicit courts override register inference and route all case fields",
      fc.property(caseNumber, (parts) => {
        const fields = {
          bcVec: String(parts.bcVec),
          cisloSenatu: String(parts.cisloSenatu),
          druhVeci: parts.druhVeci.toUpperCase(),
          rocnik: String(parts.rocnik),
        };
        const text = formatSpisZnCanonical(parts);
        for (const [court, selector] of [
          ["NS", { typOrganizace: "NEJVYSSI" }],
          ["KSSEMOC", { druhOrganizace: "KSSEMOS" }],
          ["MSPHAAB", { druhOrganizace: "MSPHAAB" }],
          ["VSSTCAB", { druhOrganizace: "VSPHAAB" }],
          ["OSPHA09", { okresniSoud: "OSPHA09" }],
        ] as const) {
          const parsed = parseSpisZn(`${text} ${court}`);
          expect(parsed.courtCode).toBe(court);
          expect(toInfoSoudRequestBody(parsed)).toEqual({
            ...fields,
            ...selector,
          });
          expect(toInfoSoudRequestBody(parsed, "NS")).toEqual({
            ...fields,
            typOrganizace: "NEJVYSSI",
          });
          expect(toInfoSoudRequestBody(parsed, " ospha09 ")).toEqual({
            ...fields,
            okresniSoud: "OSPHA09",
          });
        }
      }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "every declared supreme register infers the court without overriding an explicit one",
  () => {
    assertProperty(
      "every declared supreme register infers the court without overriding an explicit one",
      fc.property(caseNumber, (parts) => {
        for (const registry of NS_CASE_TYPES) {
          const text = `${parts.cisloSenatu}${registry.toLowerCase()}${parts.bcVec}/${parts.rocnik}`;
          expect(parseSpisZn(text)).toEqual({
            ...parts,
            druhVeci: registry,
            courtCode: "NS",
          });
          expect(parseSpisZn(`${text} OSPHA09`)).toEqual({
            ...parts,
            druhVeci: registry,
            courtCode: "OSPHA09",
          });
        }
      }),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "court queries preserve the entire trailing name and leave the docket parseable",
  () => {
    assertProperty(
      "court queries preserve the entire trailing name and leave the docket parseable",
      fc.property(
        caseNumber,
        spacing,
        fc.constantFrom(
          "Okresní soud v Mělníku",
          "Krajský soud v Ústí nad Labem",
          "Vrchní soud v Olomouci",
          "Městský soud v Praze",
        ),
        (parts, gap, courtQuery) => {
          const docket = formatSpisZnCompact(parts);
          const split = splitSpisZnAndCourtQuery(
            `${gap}${docket}${gap}${courtQuery}${gap}`,
          );
          expect(split).toEqual({ spisZn: docket, courtQuery });
          expect(parseSpisZn(split.spisZn)).toEqual(parseSpisZn(docket));
        },
      ),
    );
  },
  propertyTestTimeout(5000),
);

test(
  "malformed year widths and surrounding words are rejected as case numbers",
  () => {
    assertProperty(
      "malformed year widths and surrounding words are rejected as case numbers",
      fc.property(caseNumber, (parts) => {
        const head = `${parts.cisloSenatu} ${parts.druhVeci} ${parts.bcVec}/`;
        for (const year of [
          String(parts.rocnik).slice(1),
          `${parts.rocnik}0`,
          `x${parts.rocnik}`,
        ]) {
          expect(() => parseSpisZn(`${head}${year}`)).toThrow(
            InfoSoudParseError,
          );
        }
        const text = formatSpisZnCanonical(parts);
        for (const entry of [
          `rozsudek ${text}`,
          `${text} rozsudek`,
          `${text}/1`,
          `${text} XXUNKNOWN`,
        ]) {
          expect(() => parseSpisZn(entry)).toThrow(InfoSoudParseError);
        }
      }),
    );
  },
  propertyTestTimeout(5000),
);
