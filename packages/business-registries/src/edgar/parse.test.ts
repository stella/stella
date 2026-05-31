import { describe, expect, test } from "bun:test";

import appleFixture from "./__fixtures__/cik-apple.json" with { type: "json" };
import { parseAddress, parseSubmission } from "./parse.js";
import type { EdgarRawSubmission } from "./types.js";

// Pin "now" relative to the fixture so the derived status test stays
// deterministic regardless of when the suite runs.
const APPLE_FIXTURE_NOW = Date.parse("2026-06-01T00:00:00Z");

// SAFETY: the captured EDGAR fixture is a real `data.sec.gov`
// response trimmed to 5 filings; its shape matches `EdgarRawSubmission`
// by construction (the parser tolerates absent optional fields, so
// the cast narrows JSON `unknown` to the documented response type
// without runtime risk).
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const apple = appleFixture as unknown as EdgarRawSubmission;

describe("parseAddress", () => {
  test("composes textAddress from street, city, state, postal code", () => {
    const out = parseAddress({
      street1: "ONE APPLE PARK WAY",
      city: "CUPERTINO",
      stateOrCountry: "CA",
      zipCode: "95014",
    });
    expect(out.street).toBe("ONE APPLE PARK WAY");
    expect(out.city).toBe("CUPERTINO");
    expect(out.region).toBe("CA");
    expect(out.postalCode).toBe("95014");
    expect(out.textAddress).toBe("ONE APPLE PARK WAY, 95014 CUPERTINO, CA");
  });

  test("joins street1 and street2 with a comma", () => {
    const out = parseAddress({
      street1: "100 Main St",
      street2: "Suite 200",
      city: "NEW YORK",
      stateOrCountry: "NY",
      zipCode: "10001",
    });
    expect(out.street).toBe("100 Main St, Suite 200");
  });

  test("prefers stateOrCountryDescription over the two-letter code", () => {
    const out = parseAddress({
      city: "DUBLIN",
      stateOrCountry: "L2",
      stateOrCountryDescription: "IRELAND",
    });
    expect(out.region).toBe("IRELAND");
  });

  test("falls back to nulls on an empty address", () => {
    const out = parseAddress({});
    expect(out.street).toBeNull();
    expect(out.city).toBeNull();
    expect(out.textAddress).toBeNull();
  });

  test("ignores blank string values from EDGAR", () => {
    const out = parseAddress({ street1: "   ", city: "", zipCode: "" });
    expect(out.street).toBeNull();
    expect(out.city).toBeNull();
    expect(out.postalCode).toBeNull();
    expect(out.textAddress).toBeNull();
  });
});

describe("parseSubmission (Apple fixture)", () => {
  test("maps top-level identifiers", () => {
    const out = parseSubmission(apple, { now: APPLE_FIXTURE_NOW });
    expect(out.cik).toBe("0000320193");
    expect(out.name).toBe("Apple Inc.");
    expect(out.sic).toBe("3571");
    expect(out.sicDescription).toBe("Electronic Computers");
    expect(out.tickers).toEqual(["AAPL"]);
    expect(out.exchanges).toEqual(["Nasdaq"]);
    expect(out.ein).toBe("942404110");
  });

  test("parses both addresses", () => {
    const out = parseSubmission(apple, { now: APPLE_FIXTURE_NOW });
    expect(out.addresses.business?.street).toBe("ONE APPLE PARK WAY");
    expect(out.addresses.business?.city).toBe("CUPERTINO");
    expect(out.addresses.mailing?.postalCode).toBe("95014");
  });

  test("keeps the top 5 recent filings", () => {
    const out = parseSubmission(apple, { now: APPLE_FIXTURE_NOW });
    expect(out.recentFilings).toHaveLength(5);
    const first = out.recentFilings[0];
    expect(first?.accessionNumber).toBe("0001140361-26-023363");
    expect(first?.form).toBe("4");
    expect(first?.filingDate).toBe("2026-05-29");
  });

  test("skips incomplete recent filing rows without counting them against the limit", () => {
    const out = parseSubmission(
      {
        cik: "0000000123",
        name: "Sparse Filings Inc.",
        entityType: "operating",
        filings: {
          recent: {
            accessionNumber: [
              "missing-form",
              "valid-1",
              "valid-2",
              "valid-3",
              "valid-4",
              "valid-5",
            ],
            form: ["", "8-K", "10-Q", "10-K", "4", "DEF 14A"],
            filingDate: [
              "2026-05-30",
              "2026-05-29",
              "2026-05-28",
              "2026-05-27",
              "2026-05-26",
              "2026-05-25",
            ],
          },
        },
      },
      { now: APPLE_FIXTURE_NOW },
    );

    expect(out.recentFilings).toHaveLength(5);
    expect(out.recentFilings.map((filing) => filing.accessionNumber)).toEqual([
      "valid-1",
      "valid-2",
      "valid-3",
      "valid-4",
      "valid-5",
    ]);
  });

  test("derives active status from a recent filing + operating entityType", () => {
    const out = parseSubmission(apple, { now: APPLE_FIXTURE_NOW });
    expect(out.status).toEqual({ type: "active" });
  });

  test("derives stale status when the most recent filing is old", () => {
    const stale = parseSubmission(apple, {
      now: Date.parse("2030-01-01T00:00:00Z"),
    });
    expect(stale.status).toEqual({
      type: "stale",
      lastFilingDate: "2026-05-29",
    });
  });

  test("treats missing filings as unknown even when entityType is operating", () => {
    const out = parseSubmission(
      { cik: "0000000123", name: "No Filings Inc.", entityType: "operating" },
      { now: APPLE_FIXTURE_NOW },
    );
    expect(out.status).toEqual({ type: "unknown" });
    expect(out.recentFilings).toEqual([]);
  });

  test("treats missing filings as unknown when entityType is non-operating", () => {
    const out = parseSubmission(
      { cik: "0000000123", name: "Defunct Co", entityType: "other" },
      { now: APPLE_FIXTURE_NOW },
    );
    expect(out.status).toEqual({ type: "unknown" });
    expect(out.recentFilings).toEqual([]);
  });

  test("maps formerNames preserving from/to strings", () => {
    const out = parseSubmission(apple, { now: APPLE_FIXTURE_NOW });
    expect(out.formerNames).toHaveLength(3);
    expect(out.formerNames[0]?.name).toBe("APPLE INC");
    expect(out.formerNames[0]?.from).toBe("2007-01-10T05:00:00.000Z");
  });

  test("builds a browse-EDGAR registry URL", () => {
    const out = parseSubmission(apple, { now: APPLE_FIXTURE_NOW });
    expect(out.registryUrl).toBe(
      "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193",
    );
  });
});
