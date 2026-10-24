import { TaggedError } from "better-result";
import * as v from "valibot";

import { normalizeVatExchangeRate, type VatRateCountry } from "@stll/invoicing";
import { Temporal } from "@stll/time";

export class VatRateUnavailableError extends TaggedError(
  "VatRateUnavailableError",
)<{ message: string; error?: unknown }> {}
export class VatRateCurrencyError extends TaggedError("VatRateCurrencyError")<{
  message: string;
  currency: string;
}> {}
export class VatRateMalformedError extends TaggedError(
  "VatRateMalformedError",
)<{ message: string; error?: unknown }> {}

export type VatExchangeRate = {
  rate: string;
  source: "CNB" | "ECB" | "NBP";
  effectiveDate: string;
  sourceReference: string | null;
};

type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
const TIMEOUT_MS = 10_000;
const daysBefore = (date: string, days: number) =>
  Temporal.PlainDate.from(date).subtract({ days }).toString();

const request = async (url: string, fetcher: Fetcher) => {
  let response: Response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json, text/plain" },
    });
  } catch (error) {
    throw new VatRateUnavailableError({
      message:
        "The official VAT exchange-rate service is unavailable; retry finalizing later",
      error,
    });
  }
  if (!response.ok) {
    throw new VatRateUnavailableError({
      message: `The official VAT exchange-rate service returned HTTP ${response.status}; retry finalizing later`,
    });
  }
  return response;
};

const nbpSchema = v.object({
  rates: v.array(
    v.object({ no: v.string(), effectiveDate: v.string(), mid: v.number() }),
  ),
});
const ecbSchema = v.object({
  dataSets: v.array(
    v.object({
      series: v.record(
        v.string(),
        v.object({ observations: v.record(v.string(), v.tuple([v.number()])) }),
      ),
    }),
  ),
  structure: v.object({
    dimensions: v.object({
      observation: v.array(
        v.object({ values: v.array(v.object({ id: v.string() })) }),
      ),
    }),
  }),
});

export const fetchVatExchangeRate = async (input: {
  country: VatRateCountry;
  currency: string;
  taxPointDate: string;
  fetcher?: Fetcher;
}): Promise<VatExchangeRate> => {
  const fetcher = input.fetcher ?? fetch;
  if (input.country === "CZ") {
    // CZ zákon 235/2004 Sb. § 4 odst. 8: use the ČNB rate valid on the tax point (the daily file carries forward on non-publication days).
    const displayDate = input.taxPointDate.split("-").toReversed().join(".");
    const response = await request(
      `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt?date=${displayDate}`,
      fetcher,
    );
    const text = await response.text();
    const lines = text.trim().split(/\r?\n/u);
    const effective = /(\d{2}\.\d{2}\.\d{4})/u.exec(lines.at(0) ?? "")?.[1];
    const row = lines
      .slice(2)
      .map((line) => line.split("|"))
      .find((columns) => columns[3] === input.currency);
    if (!row) {
      throw new VatRateCurrencyError({
        message: `ČNB does not publish a ${input.currency} rate`,
        currency: input.currency,
      });
    }
    if (!effective || !row[2] || !row[4] || !/^\d+$/u.test(row[2])) {
      throw new VatRateMalformedError({
        message: "ČNB returned a malformed daily-rate file",
      });
    }
    return {
      rate: normalizeVatExchangeRate({
        quote: row[4].replace(",", "."),
        foreignUnits: Number(row[2]),
        direction: "home_per_foreign",
      }),
      source: "CNB",
      effectiveDate: effective.split(".").toReversed().join("-"),
      sourceReference: null,
    };
  }
  if (input.country === "SK") {
    // SK zákon 222/2004 Z. z. § 26 ods. 1: use the ECB rate from the day before the tax point; latest earlier publication on a gap (weekend rule UNVERIFIED).
    const end = daysBefore(input.taxPointDate, 1);
    const response = await request(
      `https://data-api.ecb.europa.eu/service/data/EXR/D.${encodeURIComponent(input.currency)}.EUR.SP00.A?startPeriod=${daysBefore(end, 10)}&endPeriod=${end}&format=jsondata`,
      fetcher,
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new VatRateMalformedError({
        message: "ECB returned invalid JSON",
        error,
      });
    }
    const parsed = v.safeParse(ecbSchema, body);
    if (!parsed.success) {
      throw new VatRateMalformedError({
        message: "ECB returned a malformed exchange-rate response",
        error: parsed.issues,
      });
    }
    const observations = Object.entries(
      parsed.output.dataSets.at(0)?.series["0:0:0:0:0"]?.observations ?? {},
    );
    const dates =
      parsed.output.structure.dimensions.observation.at(0)?.values ?? [];
    const last = observations.at(-1);
    const date = last === undefined ? undefined : dates[Number(last[0])]?.id;
    const quote = last?.[1][0];
    if (date === undefined || quote === undefined) {
      throw new VatRateCurrencyError({
        message: `ECB does not publish a ${input.currency} rate`,
        currency: input.currency,
      });
    }
    return {
      rate: normalizeVatExchangeRate({
        quote: String(quote),
        foreignUnits: 1,
        direction: "foreign_per_home",
      }),
      source: "ECB",
      effectiveDate: date,
      sourceReference: null,
    };
  }
  // PL ustawa o VAT art. 31a ust. 1: use NBP table A's latest effectiveDate strictly before the tax point.
  const end = daysBefore(input.taxPointDate, 1);
  const response = await request(
    `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(input.currency)}/${daysBefore(end, 10)}/${end}/?format=json`,
    fetcher,
  );
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new VatRateMalformedError({
      message: "NBP returned invalid JSON",
      error,
    });
  }
  const parsed = v.safeParse(nbpSchema, body);
  if (!parsed.success) {
    throw new VatRateMalformedError({
      message: "NBP returned a malformed exchange-rate response",
      error: parsed.issues,
    });
  }
  const rate = parsed.output.rates.findLast(
    ({ effectiveDate }) => effectiveDate < input.taxPointDate,
  );
  if (!rate) {
    throw new VatRateCurrencyError({
      message: `NBP does not publish a ${input.currency} rate`,
      currency: input.currency,
    });
  }
  return {
    rate: normalizeVatExchangeRate({
      quote: String(rate.mid),
      foreignUnits: 1,
      direction: "home_per_foreign",
    }),
    source: "NBP",
    effectiveDate: rate.effectiveDate,
    sourceReference: rate.no,
  };
};
