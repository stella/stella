import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  fetchVatExchangeRate,
  VatRateCurrencyError,
  VatRateMalformedError,
} from "./vat-exchange-rates";

const fixtureFetch =
  (body: string, seen?: string[]) => async (input: string | URL | Request) => {
    seen?.push(input instanceof Request ? input.url : input.toString());
    return new Response(body);
  };

describe("official VAT exchange rates", () => {
  test("normalizes the ČNB množství column", async () => {
    const rate = await fetchVatExchangeRate({
      country: "CZ",
      currency: "JPY",
      taxPointDate: "2026-10-24",
      fetcher: fixtureFetch(
        "24.10.2026 #205\nzemě|měna|množství|kód|kurz\nJaponsko|jen|100|JPY|14,250",
      ),
    });
    expect(rate).toEqual({
      rate: "0.1425",
      source: "CNB",
      effectiveDate: "2026-10-24",
      sourceReference: null,
    });
  });

  test("uses the latest ECB publication in the range ending the day before", async () => {
    const seen: string[] = [];
    const rate = await fetchVatExchangeRate({
      country: "SK",
      currency: "USD",
      taxPointDate: "2026-10-26",
      fetcher: fixtureFetch(
        JSON.stringify({
          dataSets: [
            { series: { "0:0:0:0:0": { observations: { "0": [1.25] } } } },
          ],
          structure: {
            dimensions: { observation: [{ values: [{ id: "2026-10-23" }] }] },
          },
        }),
        seen,
      ),
    });
    expect(rate.effectiveDate).toBe("2026-10-23");
    expect(rate.rate).toBe("0.8");
    expect(seen.at(0)).toContain("endPeriod=2026-10-25");
  });

  test("selects the latest NBP effectiveDate strictly before the tax point", async () => {
    const rate = await fetchVatExchangeRate({
      country: "PL",
      currency: "EUR",
      taxPointDate: "2026-01-02",
      fetcher: fixtureFetch(
        JSON.stringify({
          rates: [
            { no: "252/A/NBP/2025", effectiveDate: "2025-12-31", mid: 4.2268 },
          ],
        }),
      ),
    });
    expect(rate).toEqual({
      rate: "4.2268",
      source: "NBP",
      effectiveDate: "2025-12-31",
      sourceReference: "252/A/NBP/2025",
    });
  });

  test("returns typed errors for malformed and missing currency responses", async () => {
    expect(
      await rejectionOf(
        fetchVatExchangeRate({
          country: "PL",
          currency: "XYZ",
          taxPointDate: "2026-01-02",
          fetcher: fixtureFetch("{}"),
        }),
      ),
    ).toBeInstanceOf(VatRateMalformedError);
    expect(
      await rejectionOf(
        fetchVatExchangeRate({
          country: "CZ",
          currency: "XYZ",
          taxPointDate: "2026-01-02",
          fetcher: fixtureFetch("02.01.2026 #1\nzemě|měna|množství|kód|kurz"),
        }),
      ),
    ).toBeInstanceOf(VatRateCurrencyError);
  });
});
