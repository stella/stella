import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { APIError } from "@/lib/errors/api";

import { SellerProfileRefusal } from "./seller-profile-refusal";

const catalogs = { en, ar };
const RAW_MESSAGE = "Private server details <script>secret()</script>";

const renderRefusal = (error: unknown, locale: keyof typeof catalogs) =>
  renderToStaticMarkup(
    <IntlProvider locale={locale} messages={catalogs[locale]} timeZone="UTC">
      <SellerProfileRefusal error={error} />
    </IntlProvider>,
  );

describe("seller profile refusal alerts", () => {
  for (const locale of ["en", "ar"] as const) {
    for (const status of [400, 404, 500] as const) {
      test(`unclassified ${status} errors show a safe localized alert in ${locale}`, () => {
        const markup = renderRefusal(
          new APIError({
            status,
            code: "unclassified_seller_profile_error",
            message: RAW_MESSAGE,
            rawMessage: RAW_MESSAGE,
          }),
          locale,
        );

        expect(markup).toContain('role="alert"');
        expect(markup).toContain(catalogs[locale].errors.actionFailed);
        expect(markup).not.toContain("Private server details");
        expect(markup).not.toContain("secret()");
      });
    }

    test(`unknown thrown values use the localized fallback in ${locale}`, () => {
      for (const error of [
        { message: RAW_MESSAGE, status: 400, code: "validation" },
        RAW_MESSAGE,
        null,
      ]) {
        const markup = renderRefusal(error, locale);

        expect(markup).toContain('role="alert"');
        expect(markup).toContain(catalogs[locale].errors.actionFailed);
        expect(markup).not.toContain("Private server details");
        expect(markup).not.toContain("secret()");
      }
    });

    test(`recognized validation errors show the safe message without raw details in ${locale}`, () => {
      const message = catalogs[locale].errors.api.validation;
      const markup = renderRefusal(
        new APIError({
          code: "validation",
          status: 400,
          message,
          rawMessage: RAW_MESSAGE,
        }),
        locale,
      );

      expect(markup).toContain('role="alert"');
      expect(markup).toContain(message);
      expect(markup).not.toContain("Private server details");
    });
  }
});
