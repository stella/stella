import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { APIError } from "@/lib/errors/api";

import { TimerError } from "./timer-error";

const catalogs = { en, ar };

const renderError = (error: Error | null, locale: keyof typeof catalogs) =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalogs[locale]} timeZone="UTC">
      <TimerError error={error} />
    </IntlProvider>,
  );

describe("timer inline refusal alerts", () => {
  for (const locale of ["en", "ar"] as const) {
    for (const [code, messageKey] of [
      ["narrative_required", "narrativeRequired"],
      ["time_period_locked", "periodLocked"],
    ] as const) {
      test(`${code} shows a localized actionable alert in ${locale}`, () => {
        const markup = renderError(
          new APIError({ code, status: 409, message: "Server refusal" }),
          locale,
        );

        expect(markup).toContain('role="alert"');
        expect(markup).toContain(
          catalogs[locale].billing.globalTimer[messageKey],
        );
        expect(markup).not.toContain("Server refusal");
      });
    }
  }

  test("no error renders no alert", () => {
    expect(renderError(null, "en")).toBe("");
    expect(renderError(null, "ar")).toBe("");
  });

  test("unknown refusals surface their message as escaped text", () => {
    const markup = renderError(
      new APIError({
        code: "unknown_refusal",
        status: 409,
        message: '<script>alert("blocked")</script> & retry',
      }),
      "en",
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain(
      "&lt;script&gt;alert(&quot;blocked&quot;)&lt;/script&gt; &amp; retry",
    );
    expect(markup).not.toContain("<script>");
  });
});
