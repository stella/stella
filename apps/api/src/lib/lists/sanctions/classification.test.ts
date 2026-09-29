import { describe, expect, test } from "bun:test";

import { SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsIssuer } from "@stll/sanctions";

import { classifySanctionsIssuer } from "./classification";

type Row = {
  issuer: SanctionsIssuer;
  jurisdictions: readonly string[];
  expected: "binding" | "informational";
};

const TABLE: readonly Row[] = [
  // EU and UN bind a firm practising in any EU member state.
  { issuer: "EU", jurisdictions: ["CZ"], expected: "binding" },
  { issuer: "EU", jurisdictions: ["SK"], expected: "binding" },
  { issuer: "EU", jurisdictions: ["GB", "DE"], expected: "binding" },
  { issuer: "UN", jurisdictions: ["AT"], expected: "binding" },
  { issuer: "EU", jurisdictions: ["GB"], expected: "informational" },
  { issuer: "UN", jurisdictions: ["US", "CH"], expected: "informational" },
  // A national list binds a firm practising in its own country only.
  { issuer: "CZ", jurisdictions: ["CZ"], expected: "binding" },
  { issuer: "CZ", jurisdictions: ["SK"], expected: "informational" },
  { issuer: "US", jurisdictions: ["US"], expected: "binding" },
  { issuer: "US", jurisdictions: ["CZ"], expected: "informational" },
  { issuer: "GB", jurisdictions: ["GB"], expected: "binding" },
  { issuer: "GB", jurisdictions: ["IE"], expected: "informational" },
  { issuer: "CH", jurisdictions: ["CH"], expected: "binding" },
  { issuer: "CH", jurisdictions: ["DE"], expected: "informational" },
  { issuer: "UA", jurisdictions: ["UA", "PL"], expected: "binding" },
  // Stored codes are upper case; a stray lower-case one still counts.
  { issuer: "CZ", jurisdictions: ["cz"], expected: "binding" },
];

describe("sanctions list classification", () => {
  test.each(TABLE)(
    "$issuer for a firm in $jurisdictions is $expected",
    ({ issuer, jurisdictions, expected }) => {
      expect(classifySanctionsIssuer(issuer, jurisdictions)).toBe(expected);
    },
  );

  test("every registered list is informational when no jurisdiction is set", () => {
    for (const source of Object.values(SANCTIONS_SOURCES)) {
      expect(classifySanctionsIssuer(source.issuer, [])).toBe("informational");
    }
  });

  test("every registered national list binds a firm in its issuing country", () => {
    for (const source of Object.values(SANCTIONS_SOURCES)) {
      const firmCountry =
        source.issuer === "EU" || source.issuer === "UN" ? "CZ" : source.issuer;
      expect(classifySanctionsIssuer(source.issuer, [firmCountry])).toBe(
        "binding",
      );
    }
  });
});
