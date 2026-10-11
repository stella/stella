import { expect, test } from "bun:test";

import {
  courtAbbreviation,
  COURT_NAME_REGISTRY,
} from "./case-law-court-abbreviations";
import { ECLI_COURT_REGISTRY } from "./case-law-courts";
import { SK_COURT_TIERS } from "./sk-court-tiers";

const COUNTRY_BY_ECLI_JURISDICTION = new Map([
  ["CZ", "CZE"],
  ["SK", "SVK"],
  ["EU", "EU"],
]);

test("every registered ECLI court has one shared short code with and without its identifier", () => {
  for (const [jurisdiction, courts] of Object.entries(ECLI_COURT_REGISTRY)) {
    const country = COUNTRY_BY_ECLI_JURISDICTION.get(jurisdiction);
    expect(country, jurisdiction).toBeDefined();
    if (country === undefined) {
      throw new Error(`Missing test country for ${jurisdiction}`);
    }
    for (const [code, court] of Object.entries(courts)) {
      expect(court.shortCode, code).not.toBe("");
      expect(
        courtAbbreviation({
          country,
          court: court.name,
          ecli: `ECLI:${jurisdiction}:${code}:2024:1`,
        }),
        code,
      ).toBe(court.shortCode);
      expect(courtAbbreviation({ country, court: court.name }), code).toBe(
        court.shortCode,
      );
    }
  }
});

test("every registered jurisdiction court pattern carries a short code", () => {
  for (const [jurisdiction, courts] of Object.entries(COURT_NAME_REGISTRY)) {
    for (const court of courts) {
      expect(court.shortCode, jurisdiction).not.toBe("");
    }
  }
});

test("every publisher Slovak court type resolves its registered short code", () => {
  for (const [name, registeredCourt] of Object.entries(SK_COURT_TIERS)) {
    expect(courtAbbreviation({ country: "SVK", court: name })).toBe(
      registeredCourt.shortCode,
    );
    expect(
      courtAbbreviation({ country: "SVK", court: `${name} Bratislava` }),
    ).toBe(registeredCourt.shortCode);
  }
});
