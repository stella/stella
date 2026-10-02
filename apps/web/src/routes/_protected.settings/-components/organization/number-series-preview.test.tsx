import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { APIError } from "@/lib/errors/api";
import type { NumberSeriesPreviewData } from "@/lib/organization/number-series";
import { toSafeId } from "@/lib/safe-id";
import {
  NumberSeriesPreviewValue,
  NumberSeriesRefusal,
} from "@/routes/_protected.settings/-components/organization/number-series-preview";

const LOCALES = [
  { locale: "en", messages: en },
  { locale: "ar", messages: ar },
] as const;

const PREVIEW = {
  seriesId: toSafeId<"numberSeries">("e6cb934a-986f-45e6-a76f-af4c28e5ee33"),
  number: "2030/007",
  availability: "available",
} as const satisfies NumberSeriesPreviewData;

describe("number series preview", () => {
  for (const { locale, messages } of LOCALES) {
    test(`preserves the server number and translates allocation warnings in ${locale}`, () => {
      const available = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <NumberSeriesPreviewValue preview={PREVIEW} />
        </IntlProvider>,
      );
      expect(available).toContain("2030/007");
      expect(available).not.toContain('role="status"');
      const allocated = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <NumberSeriesPreviewValue
            preview={{ ...PREVIEW, availability: "already_allocated" }}
          />
        </IntlProvider>,
      );
      expect(allocated).toContain("2030/007");
      expect(allocated).toContain('role="status"');
      expect(allocated).toContain(
        messages.billing.numberSeries.previewAllocated,
      );
    });

    test(`renders safe inline refusals without server details in ${locale}`, () => {
      for (const status of [400, 409, 500]) {
        const error = new APIError({
          status,
          message: "private-server-details",
          rawMessage: "private-raw-response",
        });
        const markup = renderToStaticMarkup(
          <IntlProvider locale={locale} messages={messages} timeZone="UTC">
            <NumberSeriesRefusal error={error} />
          </IntlProvider>,
        );
        expect(markup).toContain('role="alert"');
        expect(markup).toContain(messages.errors.actionFailed);
        expect(markup).not.toContain(error.message);
        expect(markup).not.toContain(
          error.rawMessage ?? "private-raw-response",
        );
      }
    });
  }
});
