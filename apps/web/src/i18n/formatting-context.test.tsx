import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider, useTranslations } from "use-intl";

import { FormattingProvider, useFormatter } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/ar.json";
import type Messages from "@/i18n/langs/messages.gen";

const FormattingProbe = () => {
  const t = useTranslations("billing.invoices");
  const format = useFormatter();

  return (
    <>
      {t("totalEntries", { count: 2 })}
      {"|"}
      {format.number(100_000, { style: "currency", currency: "INR" })}
    </>
  );
};

test("formatting locale does not replace translated-message plural rules", () => {
  const markup = renderToStaticMarkup(
    <IntlProvider
      locale="ar"
      // SAFETY: locale catalogs are structurally checked against the generated
      // Messages schema; dynamic JSON widens only the string literal leaves.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      messages={messages as Messages}
      timeZone="UTC"
    >
      <FormattingProvider locale="en-IN" timeZone="UTC">
        <FormattingProbe />
      </FormattingProvider>
    </IntlProvider>,
  );

  expect(markup).toBe("إدخالان|₹1,00,000.00");
});
