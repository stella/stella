import { Result, TaggedError } from "better-result";
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
  const requested = await Result.tryPromise({
    try: async () =>
      await fetcher(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json, text/plain" },
      }),
    catch: (error) =>
      new VatRateUnavailableError({
        message:
          "The official VAT exchange-rate service is unavailable; retry finalizing later",
        error,
      }),
  });
  if (Result.isError(requested)) {
    return requested;
  }
  const response = requested.value;
  if (!response.ok) {
    return Result.err(
      new VatRateUnavailableError({
        message: `The official VAT exchange-rate service returned HTTP ${response.status}; retry finalizing later`,
      }),
    );
  }
  return Result.ok(response);
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

export type VatExchangeRateError =
  VatRateUnavailableError | VatRateCurrencyError | VatRateMalformedError;

const malformed = (message: string, error?: unknown) =>
  Result.err(new VatRateMalformedError({ message, error }));

const normalizeRate = (
  input: Parameters<typeof normalizeVatExchangeRate>[0],
) => {
  const normalized = Result.try({
    try: () => normalizeVatExchangeRate(input),
    catch: (error) =>
      new VatRateMalformedError({
        message: "The official service returned an invalid exchange rate",
        error,
      }),
  });
  return normalized;
};

type RateRequest = { currency: string; taxPointDate: string; fetcher: Fetcher };
type RateResult = Promise<Result<VatExchangeRate, VatExchangeRateError>>;

const fetchCnbRate = async ({
  currency,
  taxPointDate,
  fetcher,
}: RateRequest): RateResult => {
  // CZ zákon 235/2004 Sb. § 4 odst. 8: use the ČNB rate valid on the tax point (the daily file carries forward on non-publication days).
  const displayDate = taxPointDate.split("-").toReversed().join(".");
  const requested = await request(
    `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt?date=${displayDate}`,
    fetcher,
  );
  if (Result.isError(requested)) {
    return requested;
  }
  const response = requested.value;
  const body = await Result.tryPromise({
    try: async () => await response.text(),
    catch: (error) =>
      new VatRateUnavailableError({
        message:
          "The official VAT exchange-rate service is unavailable; retry finalizing later",
        error,
      }),
  });
  if (Result.isError(body)) {
    return body;
  }
  const text = body.value;
  const lines = text.trim().split(/\r?\n/u);
  const effective = /(\d{2}\.\d{2}\.\d{4})/u.exec(lines.at(0) ?? "")?.[1];
  const row = lines
    .slice(2)
    .map((line) => line.split("|"))
    .find((columns) => columns[3] === currency);
  if (!row) {
    return Result.err(
      new VatRateCurrencyError({
        message: `ČNB does not publish a ${currency} rate`,
        currency,
      }),
    );
  }
  if (!effective || !row[2] || !row[4] || !/^\d+$/u.test(row[2])) {
    return malformed("ČNB returned a malformed daily-rate file");
  }
  const normalized = normalizeRate({
    quote: row[4].replace(",", "."),
    foreignUnits: Number(row[2]),
    direction: "home_per_foreign",
  });
  if (Result.isError(normalized)) {
    return normalized;
  }
  return Result.ok({
    rate: normalized.value,
    source: "CNB",
    effectiveDate: effective.split(".").toReversed().join("-"),
    sourceReference: null,
  });
};

const fetchEcbRate = async ({
  currency,
  taxPointDate,
  fetcher,
}: RateRequest): RateResult => {
  // SK zákon 222/2004 Z. z. § 26 ods. 1: use the ECB rate from the day before the tax point; latest earlier publication on a gap (weekend rule UNVERIFIED).
  const end = daysBefore(taxPointDate, 1);
  const requested = await request(
    `https://data-api.ecb.europa.eu/service/data/EXR/D.${encodeURIComponent(currency)}.EUR.SP00.A?startPeriod=${daysBefore(end, 10)}&endPeriod=${end}&format=jsondata`,
    fetcher,
  );
  if (Result.isError(requested)) {
    return requested;
  }
  const decoded = await Result.tryPromise({
    try: async () => await requested.value.json(),
    catch: (error) =>
      new VatRateMalformedError({
        message: "ECB returned invalid JSON",
        error,
      }),
  });
  if (Result.isError(decoded)) {
    return decoded;
  }
  const body = decoded.value;
  const parsed = v.safeParse(ecbSchema, body);
  if (!parsed.success) {
    return Result.err(
      new VatRateMalformedError({
        message: "ECB returned a malformed exchange-rate response",
        error: parsed.issues,
      }),
    );
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
    return Result.err(
      new VatRateCurrencyError({
        message: `ECB does not publish a ${currency} rate`,
        currency,
      }),
    );
  }
  const normalized = normalizeRate({
    quote: String(quote),
    foreignUnits: 1,
    direction: "foreign_per_home",
  });
  if (Result.isError(normalized)) {
    return normalized;
  }
  return Result.ok({
    rate: normalized.value,
    source: "ECB",
    effectiveDate: date,
    sourceReference: null,
  });
};

const fetchNbpRate = async ({
  currency,
  taxPointDate,
  fetcher,
}: RateRequest): RateResult => {
  // PL ustawa o VAT art. 31a ust. 1: use NBP table A's latest effectiveDate strictly before the tax point.
  const end = daysBefore(taxPointDate, 1);
  const requested = await request(
    `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(currency)}/${daysBefore(end, 10)}/${end}/?format=json`,
    fetcher,
  );
  if (Result.isError(requested)) {
    return requested;
  }
  const decoded = await Result.tryPromise({
    try: async () => await requested.value.json(),
    catch: (error) =>
      new VatRateMalformedError({
        message: "NBP returned invalid JSON",
        error,
      }),
  });
  if (Result.isError(decoded)) {
    return decoded;
  }
  const body = decoded.value;
  const parsed = v.safeParse(nbpSchema, body);
  if (!parsed.success) {
    return Result.err(
      new VatRateMalformedError({
        message: "NBP returned a malformed exchange-rate response",
        error: parsed.issues,
      }),
    );
  }
  const rate = parsed.output.rates.findLast(
    ({ effectiveDate }) => effectiveDate < taxPointDate,
  );
  if (!rate) {
    return Result.err(
      new VatRateCurrencyError({
        message: `NBP does not publish a ${currency} rate`,
        currency,
      }),
    );
  }
  const normalized = normalizeRate({
    quote: String(rate.mid),
    foreignUnits: 1,
    direction: "home_per_foreign",
  });
  if (Result.isError(normalized)) {
    return normalized;
  }
  return Result.ok({
    rate: normalized.value,
    source: "NBP",
    effectiveDate: rate.effectiveDate,
    sourceReference: rate.no,
  });
};

const VAT_RATE_SOURCES = {
  CZ: fetchCnbRate,
  SK: fetchEcbRate,
  PL: fetchNbpRate,
} as const satisfies Record<
  VatRateCountry,
  (request: RateRequest) => RateResult
>;

export const fetchVatExchangeRate = async ({
  country,
  fetcher = fetch,
  ...rateRequest
}: {
  country: VatRateCountry;
  currency: string;
  taxPointDate: string;
  fetcher?: Fetcher;
}): RateResult => await VAT_RATE_SOURCES[country]({ ...rateRequest, fetcher });
