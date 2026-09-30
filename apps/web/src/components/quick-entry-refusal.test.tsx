import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import arabicMessages from "@/i18n/langs/ar.json";
import englishMessages from "@/i18n/langs/en.json";
import { APIError } from "@/lib/errors/api";

import { QuickEntryRefusal } from "./quick-entry-refusal";

describe("quick entry refusal display", () => {
  test("renders actionable localized refusals as alerts in English and Arabic", () => {
    for (const { locale, messages } of [
      { locale: "en", messages: englishMessages },
      { locale: "ar", messages: arabicMessages },
    ]) {
      for (const [code, expected] of [
        ["invalid_date_worked", messages.billing.quickEntry.invalidDate],
        ["future_date_worked", messages.billing.quickEntry.futureDate],
        ["outside_edit_window", messages.billing.quickEntry.outsideEditWindow],
        ["narrative_required", messages.billing.quickEntry.narrativeRequired],
        ["time_period_locked", messages.billing.quickEntry.periodLocked],
      ] as const) {
        const markup = renderToStaticMarkup(
          <IntlProvider locale={locale} messages={messages} timeZone="UTC">
            <QuickEntryRefusal
              error={new APIError({ code, status: 400, message: "Refused" })}
            />
          </IntlProvider>,
        );
        expect(markup).toContain('role="alert"');
        expect(markup).toContain(expected);
        expect(markup).not.toContain("billing.quickEntry.");
      }
    }
  });

  test("renders the localized generic failure for an unexpected error", () => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" messages={englishMessages} timeZone="UTC">
        <QuickEntryRefusal
          error={
            new APIError({ code: "unknown", status: 500, message: "Failed" })
          }
        />
      </IntlProvider>,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(englishMessages.errors.actionFailed);
  });
});
