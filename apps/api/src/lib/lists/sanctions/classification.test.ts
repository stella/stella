import { describe, expect, test } from "bun:test";

import type { CountryCode } from "@stll/country-codes";
import { SANCTIONS_SOURCES } from "@stll/sanctions";
import type { SanctionsIssuer } from "@stll/sanctions";

import { classifySanctionsIssuer } from "./classification";

type Row = {
  issuer: SanctionsIssuer;
  jurisdictions: readonly CountryCode[];
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

  test("the Swiss list binds a firm practising in Switzerland only", () => {
    expect(classifySanctionsIssuer(SANCTIONS_SOURCES.ch.issuer, ["CH"])).toBe(
      "binding",
    );
    expect(
      classifySanctionsIssuer(SANCTIONS_SOURCES.ch.issuer, ["CZ", "DE"]),
    ).toBe("informational");
  });

  test("every registered national list binds a firm in its issuing country", () => {
    const firmCountryOf = (issuer: SanctionsIssuer): CountryCode =>
      issuer === "EU" || issuer === "UN" ? "CZ" : issuer;
    for (const source of Object.values(SANCTIONS_SOURCES)) {
      expect(
        classifySanctionsIssuer(source.issuer, [firmCountryOf(source.issuer)]),
      ).toBe("binding");
    }
  });
});
