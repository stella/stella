import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import path from "node:path";

import { propertyConfig, propertySeed } from "@stll/property-testing";

import { isWellFormedXml } from "./soap.js";

type SoapOracleCase = { xml: string; accepted: boolean };

// Captured before removing fast-xml-validator: 2,005 seed-2026093008 inputs
// (1,000 generated valid docs and 1,000 mutated malformed docs plus five
// strict edge cases), de-duplicated to 1,991. `accepted` records whether
// SyntaxValidator.validate completed without throwing under the old Result.try
// boundary. Keeping the oracle as data preserves that comparison without
// retaining the old package in the test graph.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSoapOracleCase = (value: unknown): value is SoapOracleCase =>
  isRecord(value) &&
  typeof value["xml"] === "string" &&
  typeof value["accepted"] === "boolean";

const oracleData: unknown = await Bun.file(
  new URL("__fixtures__/soap-well-formedness-oracle.json", import.meta.url),
).json();
if (!isRecord(oracleData) || !Array.isArray(oracleData["cases"])) {
  panic("SOAP validator oracle fixture has an invalid shape");
}
const oracleCases = oracleData["cases"].filter(isSoapOracleCase);
if (
  oracleCases.length !== oracleData["cases"].length ||
  oracleCases.length < 1900
) {
  panic(
    `SOAP validator oracle fixture has ${oracleCases.length} valid cases; expected at least 1,900`,
  );
}

const packageSourceRoot = path.resolve(import.meta.dir, "..");
const xmlFixturePaths = [
  ...new Bun.Glob("**/__fixtures__/*.xml").scanSync({
    cwd: packageSourceRoot,
    onlyFiles: true,
  }),
].toSorted();
const isSoapEnvelope = /<(?:[A-Za-z_][\w.-]*:)?Envelope(?:\s|>)/u;
const soapEnvelopeFixtures = await Promise.all(
  xmlFixturePaths.map(async (fixturePath) => ({
    fixturePath,
    text: await Bun.file(path.join(packageSourceRoot, fixturePath)).text(),
  })),
).then((fixtures) => fixtures.filter(({ text }) => isSoapEnvelope.test(text)));

const STRICTLY_REJECTED_XML = [
  "<first/><second/>",
  "<!-- --comment --><root/>",
  "<root>&nbsp;</root>",
  "<attribute",
  '<root value="<"/>',
  "<root>&#0;</root>",
] as const;

describe("SOAP XML well-formedness", () => {
  test("never accepts an input the captured legacy validator rejected", () => {
    for (const { xml, accepted } of oracleCases) {
      if (isWellFormedXml(xml)) {
        expect(accepted).toBe(true);
      }
    }
  });

  test("keeps the captured acceptance boundary over randomized corpus picks", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: oracleCases.length - 1 }),
        (index) => {
          const entry = oracleCases.at(index);
          if (entry === undefined) {
            throw new Error("Selected SOAP oracle case is missing");
          }
          if (isWellFormedXml(entry.xml)) {
            expect(entry.accepted).toBe(true);
          }
        },
      ),
      propertyConfig({ numRuns: 500, seed: propertySeed() }),
    );
  });

  test("rejects invalid XML syntax even where the legacy validator was permissive", () => {
    for (const xml of STRICTLY_REJECTED_XML) {
      expect(isWellFormedXml(xml)).toBe(false);
    }
  });

  test(`accepts every recorded SOAP Envelope fixture (${soapEnvelopeFixtures.length})`, () => {
    expect(soapEnvelopeFixtures.length).toBeGreaterThan(0);
    for (const { fixturePath, text } of soapEnvelopeFixtures) {
      expect({ fixturePath, wellFormed: isWellFormedXml(text) }).toEqual({
        fixturePath,
        wellFormed: true,
      });
    }
  });
});
