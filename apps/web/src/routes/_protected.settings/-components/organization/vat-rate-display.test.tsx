import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { APIError } from "@/lib/errors/api";
import type { VatRate } from "@/lib/organization/vat-rates";
import {
  VatRatePercentage,
  VatRateRefusal,
  vatRateStatus,
} from "@/routes/_protected.settings/-components/organization/vat-rate-display";

const LOCALES = [
  { locale: "en", messages: en },
  { locale: "ar", messages: ar },
] as const;

const PERIOD = {
  validFrom: "2030-02-01",
  validTo: "2030-03-01",
} as const satisfies Pick<VatRate, "validFrom" | "validTo">;

describe("VAT rate display", () => {
  for (const { locale, messages } of LOCALES) {
    test(`shows fractional percentage precision in ${locale}`, () => {
      const markup = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <VatRatePercentage rateBps={2125} />
        </IntlProvider>,
      );
      const expected = new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: 2,
      }).format(0.2125);
      expect(markup).toBe(expected);
    });

    test(`translates overlap and keeps server failures private in ${locale}`, () => {
      for (const status of [409, 500]) {
        const markup = renderToStaticMarkup(
          <IntlProvider locale={locale} messages={messages} timeZone="UTC">
            <VatRateRefusal
              error={
                new APIError({
                  status,
                  message: "private-server-details",
                  rawMessage: "private-raw-response",
                })
              }
            />
          </IntlProvider>,
        );
        expect(markup).toContain('role="alert"');
        expect(markup).toContain(
          status === 409
            ? messages.billing.vatRates.overlap
            : messages.errors.actionFailed,
        );
        expect(markup).not.toContain("private-server-details");
        expect(markup).not.toContain("private-raw-response");
      }
    });
  }

  test("validity starts inclusively and ends exclusively", () => {
    const cases = [
      { date: "2030-01-31", status: "future" },
      { date: PERIOD.validFrom, status: "current" },
      { date: "2030-02-28", status: "current" },
      { date: PERIOD.validTo, status: "past" },
      { date: "2030-03-02", status: "past" },
    ] as const;
    for (const { date, status } of cases) {
      expect(vatRateStatus({ rate: PERIOD, date })).toBe(status);
    }
    const openPeriod = {
      validFrom: PERIOD.validFrom,
      validTo: null,
    } as const satisfies Pick<VatRate, "validFrom" | "validTo">;
    expect(vatRateStatus({ rate: openPeriod, date: "2099-12-31" })).toBe(
      "current",
    );
    expect(vatRateStatus({ rate: openPeriod, date: "2030-01-31" })).toBe(
      "future",
    );
  });
});
