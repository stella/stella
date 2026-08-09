import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider, useTranslations } from "use-intl";

import { FormattingProvider, useFormatter } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/ar.json";

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
    <IntlProvider locale="ar" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en-IN" timeZone="UTC">
        <FormattingProbe />
      </FormattingProvider>
    </IntlProvider>,
  );

  expect(markup).toBe("إدخالان|₹1,00,000.00");
});
