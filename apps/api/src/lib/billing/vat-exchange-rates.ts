import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  normalizeVatExchangeRate,
  type VatRateCountry,
  type VatRateSource,
} from "@stll/invoicing";
import { Temporal } from "@stll/time";

import { safeOutboundFetchBytes } from "@/api/lib/auth/authorized-outbound-fetch";
import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";

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
  /** As the source publishes it; VAT_RATE_QUOTE_BASIS says which way it reads. */
  rate: string;
  source: VatRateSource;
  effectiveDate: string;
  sourceReference: string | null;
};

export type VatExchangeRateError =
  | VatRateUnavailableError
  | VatRateCurrencyError
  | VatRateMalformedError
  | VatRateNotPublishedError;

/** One fetched rate document: its HTTP status and decoded text. */
type RateDocument = { status: number; text: string };

/** Fetches one official rate document. */
export type RateTransport = (
  url: string,
) => Promise<Result<RateDocument, VatRateUnavailableError>>;

const UNAVAILABLE_MESSAGE =
  "The official VAT exchange-rate service is unavailable; retry finalizing later";
// A daily rate file is a few kilobytes: the byte cap bounds the body, and the
// header policy bounds a source that does not answer.
const MAX_RATE_DOCUMENT_BYTES = 1_048_576;
const RATE_REQUEST_TIMEOUT_MS = 20_000;

/** The production transport: bounded, and issued under the caller's permit. */
export const officialRateTransport =
  (permit: ThirdPartyOutboundPermit): RateTransport =>
  async (url) => {
    const fetched = await safeOutboundFetchBytes({
      url,
      permit,
      maxBytes: MAX_RATE_DOCUMENT_BYTES,
      timeout: { type: "headers", ms: RATE_REQUEST_TIMEOUT_MS },
      headers: { accept: "application/json, text/plain" },
    });
    if (Result.isError(fetched)) {
      return Result.err(
        new VatRateUnavailableError({
          message: UNAVAILABLE_MESSAGE,
          error: fetched.error,
        }),
      );
    }
    return Result.ok({
      status: fetched.value.status,
      text: new TextDecoder().decode(fetched.value.body),
    });
  };

const daysBefore = (date: string, days: number) =>
  Temporal.PlainDate.from(date).subtract({ days }).toString();

const currencyNotPublished = (source: RateSource, currency: string) =>
  Result.err(
    new VatRateCurrencyError({
      message: `${source} does not publish a ${currency} rate`,
      currency,
    }),
  );

const malformed = (message: string, error?: unknown) =>
  Result.err(new VatRateMalformedError({ message, error }));

type RateDocumentRequest = {
  url: string;
  transport: RateTransport;
  source: RateSource;
  currency: string;
};

/** The document text; ECB and NBP answer 404 for a currency they do not publish. */
const fetchRateDocument = async ({
  url,
  transport,
  source,
  currency,
}: RateDocumentRequest): Promise<
  Result<string, VatRateUnavailableError | VatRateCurrencyError>
> => {
  const fetched = await transport(url);
  if (Result.isError(fetched)) {
    return fetched;
  }
  const { status, text } = fetched.value;
  if (status === 404 && source !== "CNB") {
    return currencyNotPublished(source, currency);
  }
  if (status < 200 || status > 299) {
    return Result.err(
      new VatRateUnavailableError({
        message: `The official VAT exchange-rate service returned HTTP ${String(status)}; retry finalizing later`,
      }),
    );
  }
  return Result.ok(text);
};

const parseRateJson = <TSchema extends v.GenericSchema>(
  text: string,
  schema: TSchema,
  source: RateSource,
): Result<v.InferOutput<TSchema>, VatRateMalformedError> => {
  const malformedResponse = (error: unknown) =>
    new VatRateMalformedError({
      message: `${source} returned a malformed exchange-rate response`,
      error,
    });
  const decoded = Result.try({
    try: (): unknown => JSON.parse(text),
    catch: malformedResponse,
  });
  if (Result.isError(decoded)) {
    return decoded;
  }
  const parsed = v.safeParse(schema, decoded.value);
  return parsed.success
    ? Result.ok(parsed.output)
    : Result.err(malformedResponse(parsed.issues));
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

const normalizeRate = (input: Parameters<typeof normalizeVatExchangeRate>[0]) =>
  Result.try({
    try: () => normalizeVatExchangeRate(input),
    catch: (error) =>
      new VatRateMalformedError({
        message: "The official service returned an invalid exchange rate",
        error,
      }),
  });

type RateRequest = {
  currency: string;
  referenceDate: string;
  /** Today in Prague time (CET/CEST), where ČNB, ECB and NBP publish. */
  today: string;
  transport: RateTransport;
};

const notPublished = (availableFrom: string) =>
  Result.err(
    new VatRateNotPublishedError({
      message: `The official exchange rate for ${availableFrom} is not published yet`,
      availableFrom,
    }),
  );

type RateSource = VatRateSource;

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
  transport,
}: RateRequest): RateResult => {
  // ČNB's file for a future date carries the latest rate, not the one valid then.
  if (referenceDate > today) {
    return notPublished(referenceDate);
  }
  // CZ zákon 235/2004 Sb. § 4 odst. 8: use the ČNB rate valid on the tax point (the daily file carries forward on non-publication days).
  const displayDate = referenceDate.split("-").toReversed().join(".");
  const document = await fetchRateDocument({
    url: `https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt?date=${displayDate}`,
    transport,
    source: "CNB",
    currency,
  });
  if (Result.isError(document)) {
    return document;
  }
  const lines = document.value.trim().split(/\r?\n/u);
  const header = lines.at(0);
  const effective =
    header === undefined
      ? undefined
      : /(\d{2}\.\d{2}\.\d{4})/u.exec(header)?.[1];
  const row = lines
    .slice(2)
    .map((line) => line.split("|"))
    .find((columns) => columns[3] === currency);
  if (!row) {
    return currencyNotPublished("CNB", currency);
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
    units: BigInt(row[2]),
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
  transport,
}: RateRequest): RateResult => {
  // SK zákon 222/2004 Z. z. § 26 ods. 1: use the ECB rate from the day before the tax point; latest earlier publication on a gap.
  const end = daysBefore(referenceDate, 1);
  if (end > today) {
    return notPublished(end);
  }
  const document = await fetchRateDocument({
    url: `https://data-api.ecb.europa.eu/service/data/EXR/D.${encodeURIComponent(currency)}.EUR.SP00.A?startPeriod=${daysBefore(end, 10)}&endPeriod=${end}&format=jsondata`,
    transport,
    source: "ECB",
    currency,
  });
  if (Result.isError(document)) {
    return document;
  }
  const parsed = parseRateJson(document.value, ecbSchema, "ECB");
  if (Result.isError(parsed)) {
    return parsed;
  }
  const series = parsed.value.dataSets.at(0)?.series["0:0:0:0:0"];
  const dates = parsed.value.structure.dimensions.observation.at(0)?.values;
  if (series === undefined || dates === undefined) {
    return currencyNotPublished("ECB", currency);
  }
  // Observations are keyed by their index into the date dimension.
  const latest = dates
    .flatMap(({ id }, index) => {
      const observation = series.observations[String(index)];
      return observation === undefined
        ? []
        : [{ date: id, quote: observation[0] }];
    })
    .at(-1);
  if (latest === undefined) {
    return currencyNotPublished("ECB", currency);
  }
  if (
    publicationPending({
      source: "ECB",
      required: end,
      latest: latest.date,
      today,
    })
  ) {
    return notPublished(end);
  }
  const normalized = normalizeRate({
    quote: String(latest.quote),
    units: 1n,
  });
  if (Result.isError(normalized)) {
    return normalized;
  }
  return Result.ok({
    rate: normalized.value,
    source: "ECB",
    effectiveDate: latest.date,
    sourceReference: null,
  });
};

const fetchNbpRate = async ({
  currency,
  referenceDate,
  today,
  transport,
}: RateRequest): RateResult => {
  // PL ustawa o VAT art. 31a ust. 1: use NBP table A's latest effectiveDate strictly before the tax point.
  const end = daysBefore(referenceDate, 1);
  if (end > today) {
    return notPublished(end);
  }
  const document = await fetchRateDocument({
    url: `https://api.nbp.pl/api/exchangerates/rates/a/${encodeURIComponent(currency)}/${daysBefore(end, 10)}/${end}/?format=json`,
    transport,
    source: "NBP",
    currency,
  });
  if (Result.isError(document)) {
    return document;
  }
  const parsed = parseRateJson(document.value, nbpSchema, "NBP");
  if (Result.isError(parsed)) {
    return parsed;
  }
  const rate = parsed.value.rates.findLast(
    ({ effectiveDate }) => effectiveDate < referenceDate,
  );
  if (!rate) {
    return currencyNotPublished("NBP", currency);
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
    units: 1n,
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

export type VatRateRequest = {
  country: VatRateCountry;
  currency: string;
  referenceDate: string;
  transport: RateTransport;
  today?: string;
};

export const fetchVatExchangeRate = async ({
  country,
  today = Temporal.Now.plainDateISO("Europe/Prague").toString(),
  ...rateRequest
}: VatRateRequest): RateResult =>
  await VAT_RATE_SOURCES[country]({ ...rateRequest, today });
