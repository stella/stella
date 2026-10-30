import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  fetchVatExchangeRate,
  type RateTransport,
  VatRateCurrencyError,
  VatRateMalformedError,
  VatRateNotPublishedError,
  VatRateUnavailableError,
} from "./vat-exchange-rates";

const fixture = async (name: string) =>
  await Bun.file(
    new URL(`__fixtures__/vat-exchange-rates/${name}`, import.meta.url),
  ).text();

const fixtureTransport =
  (text: string, seen?: string[], status = 200): RateTransport =>
  async (url) => {
    seen?.push(url);
    return Result.ok({ status, text });
  };

const valueOf = <T, E>(result: Result<T, E>) => {
  expect(Result.isOk(result)).toBe(true);
  if (Result.isError(result)) {
    throw new TypeError("Expected an Ok result");
  }
  return result.value;
};

describe("official VAT exchange rates", () => {
  test("a Saturday tax point takes the Friday ČNB file, per 100 JPY", async () => {
    const seen: string[] = [];
    const rate = valueOf(
      await fetchVatExchangeRate({
        country: "CZ",
        currency: "JPY",
        referenceDate: "2026-10-24",
        today: "2026-12-31",
        transport: fixtureTransport(await fixture("cnb-2026-10-23.txt"), seen),
      }),
    );
    // ČNB's published daily-rate file for the reference date.
    expect(seen).toEqual([
      "https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt?date=24.10.2026",
    ]);
    // Recorded response: 13,862 CZK per 100 JPY, announced 23 October.
    expect(rate).toEqual({
      rate: "0.13862",
      source: "CNB",
      effectiveDate: "2026-10-23",
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
        today: "2026-12-31",
        transport: fixtureTransport(await fixture("ecb-2026-10-23.json"), seen),
      }),
    );
    expect(rate.effectiveDate).toBe("2026-10-23");
    expect(rate.rate).toBe("1.25");
    expect(seen.at(0)).toContain("endPeriod=2026-10-25");
  });

  test("uses Friday's recorded NBP rate after a New Year weekend", async () => {
    const rate = valueOf(
      await fetchVatExchangeRate({
        country: "PL",
        currency: "EUR",
        referenceDate: "2026-01-05",
        today: "2026-12-31",
        transport: fixtureTransport(await fixture("nbp-2026-01-02.json")),
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
      today: "2026-12-31",
      transport: fixtureTransport("{}"),
    });
    expect(Result.isError(malformed) && malformed.error).toBeInstanceOf(
      VatRateMalformedError,
    );
    const missing = await fetchVatExchangeRate({
      country: "CZ",
      currency: "XYZ",
      referenceDate: "2026-01-02",
      today: "2026-12-31",
      transport: fixtureTransport("02.01.2026 #1\nzemě|měna|množství|kód|kurz"),
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
        today: "2026-12-31",
        transport: fixtureTransport(
          "404 NotFound - Not Found - Brak danych",
          undefined,
          404,
        ),
      });
      expect(Result.isError(unpublished) && unpublished.error).toBeInstanceOf(
        VatRateCurrencyError,
      );
      const outage = await fetchVatExchangeRate({
        country,
        currency: "USD",
        referenceDate: "2026-01-05",
        today: "2026-12-31",
        transport: fixtureTransport("", undefined, 503),
      });
      expect(Result.isError(outage) && outage.error).toBeInstanceOf(
        VatRateUnavailableError,
      );
    },
  );

  test.each([
    ["CZ", "2026-10-30", "2026-10-30"],
    ["SK", "2026-10-30", "2026-10-29"],
    ["PL", "2026-10-30", "2026-10-29"],
  ] as const)(
    "%s: a future tax point is refused before any request",
    async (country, referenceDate, availableFrom) => {
      const seen: string[] = [];
      const result = await fetchVatExchangeRate({
        country,
        currency: "USD",
        referenceDate,
        today: "2026-10-26",
        transport: fixtureTransport("", seen),
      });
      const error = Result.isError(result) ? result.error : null;
      expect(error).toBeInstanceOf(VatRateNotPublishedError);
      expect(
        error instanceof VatRateNotPublishedError ? error.availableFrom : null,
      ).toBe(availableFrom);
      expect(seen).toEqual([]);
    },
  );

  test("CZ: before today's ČNB publication, a tax point today waits instead of taking yesterday's rate", async () => {
    const pending = await fetchVatExchangeRate({
      country: "CZ",
      currency: "EUR",
      referenceDate: "2026-10-26",
      today: "2026-10-26",
      transport: fixtureTransport(
        "23.10.2026 #205\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,330",
      ),
    });
    expect(Result.isError(pending) && pending.error).toBeInstanceOf(
      VatRateNotPublishedError,
    );
    // A Sunday tax point takes Friday's rate, which ČNB applies to the weekend.
    const weekend = valueOf(
      await fetchVatExchangeRate({
        country: "CZ",
        currency: "EUR",
        referenceDate: "2026-10-25",
        today: "2026-10-25",
        transport: fixtureTransport(
          "23.10.2026 #205\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,330",
        ),
      }),
    );
    expect(weekend.effectiveDate).toBe("2026-10-23");
  });

  test("CZ: on a Czech public holiday, the previous ČNB publication is final at once", async () => {
    // 2026-10-28 (Wednesday) is a public holiday: ČNB announces nothing, and
    // the 27 October rate applies to it.
    const rate = valueOf(
      await fetchVatExchangeRate({
        country: "CZ",
        currency: "EUR",
        referenceDate: "2026-10-28",
        today: "2026-10-28",
        transport: fixtureTransport(
          "27.10.2026 #207\nzemě|měna|množství|kód|kurz\nEMU|euro|1|EUR|24,330",
        ),
      }),
    );
    expect(rate.effectiveDate).toBe("2026-10-27");
  });

  test("PL: on Corpus Christi, NBP's previous table is final at once", async () => {
    // Easter 2026 falls on 5 April, so Corpus Christi is Thursday 4 June; a
    // Friday tax point needs the table of that holiday, which NBP never publishes.
    const holiday = valueOf(
      await fetchVatExchangeRate({
        country: "PL",
        currency: "EUR",
        referenceDate: "2026-06-05",
        today: "2026-06-04",
        transport: fixtureTransport(
          JSON.stringify({
            rates: [
              { no: "106/A/NBP/2026", effectiveDate: "2026-06-03", mid: 4.25 },
            ],
          }),
        ),
      }),
    );
    expect(holiday.effectiveDate).toBe("2026-06-03");
    // The day before, a working day, still waits for its own table.
    const pending = await fetchVatExchangeRate({
      country: "PL",
      currency: "EUR",
      referenceDate: "2026-06-04",
      today: "2026-06-03",
      transport: fixtureTransport(
        JSON.stringify({
          rates: [
            { no: "105/A/NBP/2026", effectiveDate: "2026-06-02", mid: 4.25 },
          ],
        }),
      ),
    });
    expect(Result.isError(pending) && pending.error).toBeInstanceOf(
      VatRateNotPublishedError,
    );
  });

  test("SK: on a Sunday, a Monday tax point takes Friday's ECB rate at once", async () => {
    // Required: Sunday 2026-10-25, a non-publication day; Friday's rate is final.
    const rate = valueOf(
      await fetchVatExchangeRate({
        country: "SK",
        currency: "USD",
        referenceDate: "2026-10-26",
        today: "2026-10-25",
        transport: fixtureTransport(await fixture("ecb-2026-10-23.json")),
      }),
    );
    expect(rate.effectiveDate).toBe("2026-10-23");
  });

  test("SK: today's ECB publication still pending refuses instead of using yesterday's", async () => {
    // Required: Monday 2026-10-26 (the day before a Tuesday tax point); the
    // response holds only Friday's publication because Monday's is not out.
    const result = await fetchVatExchangeRate({
      country: "SK",
      currency: "USD",
      referenceDate: "2026-10-27",
      today: "2026-10-26",
      transport: fixtureTransport(await fixture("ecb-2026-10-23.json")),
    });
    expect(Result.isError(result) && result.error).toBeInstanceOf(
      VatRateNotPublishedError,
    );
  });
});
