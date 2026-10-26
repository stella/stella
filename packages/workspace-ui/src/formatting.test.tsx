import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { cents, formatMoneyCents } from "@stll/money";

import { ColumnCalculation } from "./calculations";
import { FieldValue, IntFieldValue, MoneyFieldValue } from "./field-value";
import { WorkspaceUiFormattingProvider } from "./formatting";

// The UI language stays English while the formatting locale varies: a reader
// can run an English interface with any regional format.
const UI_LANGUAGE = "en";
const FORMATTING_LOCALES = [
  "de-DE",
  "en-IN",
  "fr-CH",
  "ar-u-nu-arab",
  "cs-CZ-u-fw-mon",
] as const;
const TIME_ZONE = "UTC";

const renderIn = (formattingLocale: string, node: ReactNode) =>
  renderToStaticMarkup(
    <IntlProvider locale={UI_LANGUAGE} messages={{}} timeZone={TIME_ZONE}>
      <WorkspaceUiFormattingProvider
        locale={formattingLocale}
        timeZone={TIME_ZONE}
      >
        {node}
      </WorkspaceUiFormattingProvider>
    </IntlProvider>,
  );

const CALCULATION_LABELS = {
  choose: "Choose calculation",
  kinds: {
    average: "Average",
    count: "Count",
    "count-empty": "Empty",
    "count-filled": "Filled",
    "count-unique": "Unique",
    max: "Maximum",
    median: "Median",
    min: "Minimum",
    "percent-empty": "Percent empty",
    "percent-filled": "Percent filled",
    "percent-of-total": "Percent of total",
    range: "Range",
    sum: "Sum",
  },
  noProperties: "No calculable properties",
  none: "None",
  unavailable: "Unavailable",
};

describe("formatting locale", () => {
  for (const locale of FORMATTING_LOCALES) {
    test(`an int field formats in ${locale}, not the UI language`, () => {
      const markup = renderIn(
        locale,
        <IntFieldValue
          content={{
            type: "int",
            version: 1,
            value: 1_234_567.5,
            currency: null,
          }}
        />,
      );

      expect(markup).toContain(
        new Intl.NumberFormat(locale).format(1_234_567.5),
      );
    });

    test(`a money field formats in ${locale}`, () => {
      const markup = renderIn(
        locale,
        <MoneyFieldValue
          content={{
            type: "money",
            version: 1,
            amountCents: 123_456,
            currency: "EUR",
          }}
        />,
      );

      expect(markup).toContain(
        formatMoneyCents({
          amountCents: cents(123_456),
          currency: "EUR",
          locale,
        }),
      );
    });

    test(`a date field formats in ${locale}`, () => {
      const markup = renderIn(
        locale,
        <FieldValue
          content={{ type: "date", version: 1, value: "2026-10-26" }}
          property={{ content: { type: "date" } }}
        />,
      );

      expect(markup).toContain(
        new Intl.DateTimeFormat(locale, {
          year: "numeric",
          month: "short",
          day: "numeric",
          timeZone: TIME_ZONE,
        }).format(Date.UTC(2026, 9, 26)),
      );
    });

    test(`a column sum formats in ${locale}`, () => {
      const markup = renderIn(
        locale,
        <ColumnCalculation
          kind="sum"
          labels={CALCULATION_LABELS}
          values={[
            { type: "number", value: 1_000_000 },
            { type: "number", value: 234_567 },
          ]}
        />,
      );

      expect(markup).toContain(new Intl.NumberFormat(locale).format(1_234_567));
    });
  }

  test("a formatting component outside the provider refuses to fall back to the UI language", () => {
    expect(() =>
      renderToStaticMarkup(
        <IntlProvider locale={UI_LANGUAGE} messages={{}} timeZone={TIME_ZONE}>
          <IntFieldValue
            content={{ type: "int", version: 1, value: 1, currency: null }}
          />
        </IntlProvider>,
      ),
    ).toThrow("render this component inside WorkspaceUiFormattingProvider");
  });
});
