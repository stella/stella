import { panic, Result } from "better-result";

import type { RecordValue } from "@stll/api-contract/record-schema";
import { Temporal } from "@stll/time";

import type { ThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  fetchVatExchangeRate,
  officialRateTransport,
} from "@/api/lib/billing/vat-exchange-rates";
import type { RateTransport } from "@/api/lib/billing/vat-exchange-rates";
import type {
  DataSourceInputCheck,
  DataSourceTool,
} from "@/api/lib/data-sources/contract";
import {
  DataSourceUnavailableError,
  textInput,
} from "@/api/lib/data-sources/contract";

const CZ_CNB_RATE_TOOL_ID = "cz.cnb.rate";

const HOME_CURRENCY = "CZK";

/** Drop fractional trailing zeros: `25.345000000000` reads `25.345`. */
const canonicalDecimal = (value: string): string => {
  if (!value.includes(".")) {
    return value;
  }
  let end = value.length;
  while (value[end - 1] === "0") {
    end -= 1;
  }
  return value[end - 1] === "." ? value.slice(0, end - 1) : value.slice(0, end);
};

const checkRateInput = (
  input: RecordValue,
  today: Temporal.PlainDate,
): DataSourceInputCheck => {
  const currency = textInput(input, "currency").trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency) || currency === HOME_CURRENCY) {
    return Result.err([
      {
        key: "currency",
        code: "invalid",
        message: "Not a foreign currency code (ISO 4217, other than CZK)",
      },
    ]);
  }
  const date = textInput(input, "date");
  // ČNB publishes a day's rate that afternoon; a later date has no rate yet.
  if (Temporal.PlainDate.compare(Temporal.PlainDate.from(date), today) > 0) {
    return Result.err([
      { key: "date", code: "invalid", message: "The date is in the future" },
    ]);
  }
  return Result.ok({ currency, date });
};

type CreateCzCnbRateToolOptions = {
  transportFor?: (permit: ThirdPartyOutboundPermit) => RateTransport;
};

/**
 * The Czech National Bank's daily exchange rate of a currency for a date: the
 * rate valid that day, which on a weekend or holiday is the last one published
 * before it. Reads the same ČNB daily file VAT conversion uses.
 */
export const createCzCnbRateTool = ({
  transportFor = officialRateTransport,
}: CreateCzCnbRateToolOptions = {}): DataSourceTool => ({
  id: CZ_CNB_RATE_TOOL_ID,
  description:
    "The Czech National Bank (ČNB) exchange rate of a foreign currency " +
    "against the Czech koruna, valid on a given date.",
  input: {
    cardinality: "one",
    fields: [
      {
        key: "currency",
        label: "Currency",
        type: "text",
        nullable: false,
        description: "The ISO 4217 code of the foreign currency, e.g. EUR.",
      },
      {
        key: "date",
        label: "Date",
        type: "date",
        nullable: false,
        description: "The date the rate must be valid on, as YYYY-MM-DD.",
      },
    ],
  },
  checkInput: checkRateInput,
  output: {
    schema: {
      cardinality: "one",
      fields: [
        { key: "currency", label: "Currency", type: "text", nullable: false },
        {
          key: "rate",
          label: "CZK per unit",
          type: "decimal",
          nullable: false,
        },
        {
          key: "effectiveDate",
          label: "Rate published for",
          type: "date",
          nullable: false,
        },
      ],
    },
    version: 1,
  },
  match: "exact",
  // A published rate never changes.
  cacheTtl: { hours: 24 * 30 },
  call: async (input, { observer, permit }) => {
    const currency = textInput(input, "currency");
    const referenceDate = textInput(input, "date");
    const requested: string[] = [];
    const transport = transportFor(permit);
    const fetched = await fetchVatExchangeRate({
      country: "CZ",
      currency,
      referenceDate,
      transport: async (url) => {
        requested.push(url);
        // Count the request as the registry clients do, success or failure.
        // A failing reporter must not prevent the request.
        if (observer !== "unobserved") {
          const reported = Result.try({
            try: observer.onRequest,
            catch: (cause: unknown) => cause,
          });
          if (Result.isError(reported)) {
            Result.try({
              try: () => observer.onError(reported.error),
              catch: (cause: unknown) => cause,
            }).unwrapOr(undefined);
          }
        }
        return await transport(url);
      },
    });
    const url = requested.at(-1);
    if (url === undefined) {
      // The rate owner refused before asking ČNB (a date it cannot serve yet):
      // there is no source URL to cite, so the cell is a retryable failure.
      return fetched.isOk()
        ? panic("The ČNB rate was read without a request")
        : Result.err(
            new DataSourceUnavailableError({
              message: fetched.error.message,
              toolId: CZ_CNB_RATE_TOOL_ID,
              reason: "source-error",
              cause: fetched.error,
            }),
          );
    }
    if (fetched.isOk()) {
      return Result.ok({
        type: "records",
        records: [
          {
            currency,
            rate: canonicalDecimal(fetched.value.rate),
            effectiveDate: fetched.value.effectiveDate,
          },
        ],
        url,
        sourceDataAsOf: fetched.value.effectiveDate,
      });
    }
    const { error } = fetched;
    switch (error._tag) {
      case "VatRateCurrencyError":
        return Result.ok({ type: "not-found", url });
      case "VatRateUnavailableError":
      case "VatRateNotPublishedError":
      case "VatRateMalformedError":
        return Result.err(
          new DataSourceUnavailableError({
            message: error.message,
            toolId: CZ_CNB_RATE_TOOL_ID,
            reason:
              error._tag === "VatRateMalformedError"
                ? "malformed-response"
                : "source-error",
            cause: error,
          }),
        );
      default:
        error satisfies never;
        return panic("Unknown ČNB rate error");
    }
  },
});
