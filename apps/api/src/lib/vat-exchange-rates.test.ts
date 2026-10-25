import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  fetchVatExchangeRate,
  VatRateCurrencyError,
  VatRateMalformedError,
  VatRateUnavailableError,
} from "./vat-exchange-rates";

const fixture = async (name: string) =>
  await Bun.file(
    new URL(`__fixtures__/vat-exchange-rates/${name}`, import.meta.url),
  ).text();

const fixtureFetch =
  (body: string, seen?: string[]) => async (input: string | URL | Request) => {
    seen?.push(input instanceof Request ? input.url : input.toString());
    return new Response(body);
  };

const valueOf = <T, E>(result: Result<T, E>) => {
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw new TypeError("Expected an Ok result");
  }
  return result.value;
};

describe("official VAT exchange rates", () => {
  test("normalizes the recorded ČNB množství column", async () => {
    const rate = valueOf(
      await fetchVatExchangeRate({
        country: "CZ",
        currency: "JPY",
        referenceDate: "2026-10-24",
        fetcher: fixtureFetch(await fixture("cnb-2026-10-24.txt")),
      }),
    );
    expect(rate).toEqual({
      rate: "0.1425",
      source: "CNB",
      effectiveDate: "2026-10-24",
      sourceReference: null,
    });
  });

  test("uses Friday's recorded ECB publication for a Monday tax point", async () => {
    const seen: string[] = [];
    const rate = valueOf(
      await fetchVatExchangeRate({
        country: "SK",
        currency: "USD",
        referenceDate: "2026-10-26",
        fetcher: fixtureFetch(await fixture("ecb-2026-10-23.json"), seen),
      }),
    );
    expect(rate.effectiveDate).toBe("2026-10-23");
    expect(rate.rate).toBe("0.8");
    expect(seen.at(0)).toContain("endPeriod=2026-10-25");
  });

  test("uses Friday's recorded NBP rate after a New Year weekend", async () => {
    const rate = valueOf(
      await fetchVatExchangeRate({
        country: "PL",
        currency: "EUR",
        referenceDate: "2026-01-05",
        fetcher: fixtureFetch(await fixture("nbp-2026-01-02.json")),
      }),
    );
    expect(rate).toEqual({
      rate: "4.2268",
      source: "NBP",
      effectiveDate: "2026-01-02",
      sourceReference: "001/A/NBP/2026",
    });
  });

  test("returns typed errors for malformed and missing currency responses", async () => {
    const malformed = await fetchVatExchangeRate({
      country: "PL",
      currency: "XYZ",
      referenceDate: "2026-01-02",
      fetcher: fixtureFetch("{}"),
    });
    expect(Result.isError(malformed) && malformed.error).toBeInstanceOf(
      VatRateMalformedError,
    );
    const missing = await fetchVatExchangeRate({
      country: "CZ",
      currency: "XYZ",
      referenceDate: "2026-01-02",
      fetcher: fixtureFetch("02.01.2026 #1\nzemě|měna|množství|kód|kurz"),
    });
    expect(Result.isError(missing) && missing.error).toBeInstanceOf(
      VatRateCurrencyError,
    );
  });

  test.each(["PL", "SK"] as const)(
    "%s: a 404 for an unpublished currency is a currency error, not an outage",
    async (country) => {
      const unpublished = await fetchVatExchangeRate({
        country,
        currency: "XYZ",
        referenceDate: "2026-01-05",
        fetcher: async () =>
          new Response("404 NotFound - Not Found - Brak danych", {
            status: 404,
          }),
      });
      expect(Result.isError(unpublished) && unpublished.error).toBeInstanceOf(
        VatRateCurrencyError,
      );
      const outage = await fetchVatExchangeRate({
        country,
        currency: "USD",
        referenceDate: "2026-01-05",
        fetcher: async () => new Response("", { status: 503 }),
      });
      expect(Result.isError(outage) && outage.error).toBeInstanceOf(
        VatRateUnavailableError,
      );
    },
  );
});
