import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  createFetchWithTimeout,
  type Fetcher,
  fetchWithTimeout,
  type FetchWithTimeoutInit,
} from "@stll/fetch";
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
/** The statutory publication for this date lies ahead; finalize once it exists. */
export class VatRateNotPublishedError extends TaggedError(
  "VatRateNotPublishedError",
)<{ message: string; availableFrom: string }> {}

export type VatExchangeRate = {
  rate: string;
  source: "CNB" | "ECB" | "NBP";
  effectiveDate: string;
  sourceReference: string | null;
};

/** The shared outbound transport, bound to an injected fetcher in tests. */
type Send = (url: string, init: FetchWithTimeoutInit) => Promise<Response>;
const IDLE_TIMEOUT_MS = 10_000;
const DEADLINE_MS = 30_000;
const daysBefore = (date: string, days: number) =>
  Temporal.PlainDate.from(date).subtract({ days }).toString();

type RateHttpRequest = {
  url: string;
  send: Send;
  /** ECB and NBP answer 404 for a currency they do not publish. */
  currencyOn404?: { source: string; currency: string };
};

type RateHttpResult = Result<
  Response,
  VatRateUnavailableError | VatRateCurrencyError
>;

const request = async ({
  url,
  send,
  currencyOn404,
}: RateHttpRequest): Promise<RateHttpResult> => {
  const requested = await Result.tryPromise({
    try: async () =>
      await send(url, {
        // Idle bounds every body read as well as the headers; the deadline
        // bounds a source that keeps trickling data.
        timeout: { type: "idle", ms: IDLE_TIMEOUT_MS },
        signal: AbortSignal.timeout(DEADLINE_MS),
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
  if (response.status === 404 && currencyOn404 !== undefined) {
    return Result.err(
      new VatRateCurrencyError({
        message: `${currencyOn404.source} does not publish a ${currencyOn404.currency} rate`,
        currency: currencyOn404.currency,
      }),
    );
  }
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
  | VatRateUnavailableError
  | VatRateCurrencyError
  | VatRateMalformedError
  | VatRateNotPublishedError;

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

type RateRequest = {
  currency: string;
  referenceDate: string;
  /** Today in Prague time (CET/CEST), where ČNB, ECB and NBP publish. */
  today: string;
  send: Send;
};

const notPublished = (availableFrom: string) =>
  Result.err(
    new VatRateNotPublishedError({
      message: `The official exchange rate for ${availableFrom} is not published yet`,
      availableFrom,
    }),
  );

type RateSource = VatExchangeRate["source"];

/** Gregorian Easter Sunday (anonymous Gregorian computus). */
const easterSunday = (year: number) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Temporal.PlainDate.from({ year, month, day });
};

/** Weekday dates a source does not publish on, besides weekends. */
const closedDays = (source: RateSource, year: number) => {
  const easter = easterSunday(year);
  const goodFriday = easter.subtract({ days: 2 }).toString();
  const easterMonday = easter.add({ days: 1 }).toString();
  const fixed = (monthDays: readonly string[]) =>
    monthDays.map((monthDay) => `${String(year)}-${monthDay}`);
  switch (source) {
    // ČNB announces on Czech working days: zákon 245/2000 Sb. § 1 and § 2.
    case "CNB":
      return new Set([
        ...fixed([
          "01-01",
          "05-01",
          "05-08",
          "07-05",
          "07-06",
          "09-28",
          "10-28",
          "11-17",
          "12-24",
          "12-25",
          "12-26",
        ]),
        goodFriday,
        easterMonday,
      ]);
    // ECB reference rates follow the TARGET closing days.
    case "ECB":
      return new Set([
        ...fixed(["01-01", "05-01", "12-25", "12-26"]),
        goodFriday,
        easterMonday,
      ]);
    // NBP publishes on Polish working days: ustawa o dniach wolnych od pracy
    // (24 December is a public holiday from 2025).
    case "NBP":
      return new Set([
        ...fixed([
          "01-01",
          "01-06",
          "05-01",
          "05-03",
          "08-15",
          "11-01",
          "11-11",
          "12-25",
          "12-26",
        ]),
        ...(year >= 2025 ? fixed(["12-24"]) : []),
        easterMonday,
        // Corpus Christi, the 60th day after Easter Sunday.
        easter.add({ days: 60 }).toString(),
      ]);
    default: {
      source satisfies never;
      return panic("Unknown exchange-rate source");
    }
  }
};

const isPublicationDay = (source: RateSource, date: string) => {
  const day = Temporal.PlainDate.from(date);
  return day.dayOfWeek < 6 && !closedDays(source, day.year).has(date);
};

/**
 * A rate source must hold its publication for `required`: while that day is
 * ahead, or is today's publication day and its rate is not out yet, the latest
 * observation is the wrong one. On a day the source does not publish (weekend
 * or its holiday), the previous publication is final at once, and a passed
 * day's gap is final too.
 */
const publicationPending = (input: {
  source: RateSource;
  required: string;
  latest: string;
  today: string;
}) =>
  input.required > input.today ||
  (input.required === input.today &&
    input.latest !== input.required &&
    isPublicationDay(input.source, input.required));
type RateResult = Promise<Result<VatExchangeRate, VatExchangeRateError>>;

const fetchCnbRate = async ({
  currency,
  referenceDate,
  today,
  send,
}: RateRequest): RateResult => {
  // ČNB's file for a future date carries the latest rate, not the one valid then.
  if (referenceDate > today) {
    return notPublished(referenceDate);
  }
  // CZ zákon 235/2004 Sb. § 4 odst. 8: use the ČNB rate valid on the tax point (the daily file carries forward on non-publication days).
  const displayDate = referenceDate.split("-").toReversed().join(".");
  const requested = await request({
    url: `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt?date=${displayDate}`,
    send,
  });
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
  const effectiveDate = effective.split(".").toReversed().join("-");
  // ČNB methodology: a rate announced in the afternoon of a working day applies
  // to that day and the non-working days after it; until it is announced,
  // today's rate does not exist and the file still carries the previous one.
  if (
    publicationPending({
      source: "CNB",
      required: referenceDate,
      latest: effectiveDate,
      today,
    })
  ) {
    return notPublished(referenceDate);
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
    effectiveDate,
    sourceReference: null,
  });
};

const fetchEcbRate = async ({
  currency,
  referenceDate,
  today,
  send,
}: RateRequest): RateResult => {
  // SK zákon 222/2004 Z. z. § 26 ods. 1: use the ECB rate from the day before the tax point; latest earlier publication on a gap (weekend rule UNVERIFIED).
  const end = daysBefore(referenceDate, 1);
  if (end > today) {
    return notPublished(end);
  }
  const requested = await request({
    url: `https://data-api.ecb.europa.eu/service/data/EXR/D.${encodeURIComponent(currency)}.EUR.SP00.A?startPeriod=${daysBefore(end, 10)}&endPeriod=${end}&format=jsondata`,
    send,
    currencyOn404: { source: "ECB", currency },
  });
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
  if (
    publicationPending({ source: "ECB", required: end, latest: date, today })
  ) {
    return notPublished(end);
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
  referenceDate,
  today,
  send,
}: RateRequest): RateResult => {
  // PL ustawa o VAT art. 31a ust. 1: use NBP table A's latest effectiveDate strictly before the tax point.
  const end = daysBefore(referenceDate, 1);
  if (end > today) {
    return notPublished(end);
  }
  const requested = await request({
    url: `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(currency)}/${daysBefore(end, 10)}/${end}/?format=json`,
    send,
    currencyOn404: { source: "NBP", currency },
  });
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
    ({ effectiveDate }) => effectiveDate < referenceDate,
  );
  if (!rate) {
    return Result.err(
      new VatRateCurrencyError({
        message: `NBP does not publish a ${currency} rate`,
        currency,
      }),
    );
  }
  if (
    publicationPending({
      source: "NBP",
      required: end,
      latest: rate.effectiveDate,
      today,
    })
  ) {
    return notPublished(end);
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
  fetcher,
  today = Temporal.Now.plainDateISO("Europe/Prague").toString(),
  ...rateRequest
}: {
  country: VatRateCountry;
  currency: string;
  referenceDate: string;
  today?: string;
  /** Replaces the global fetch underneath the shared transport. */
  fetcher?: Fetcher;
}): RateResult =>
  await VAT_RATE_SOURCES[country]({
    ...rateRequest,
    today,
    send:
      fetcher === undefined
        ? fetchWithTimeout
        : createFetchWithTimeout(fetcher),
  });
