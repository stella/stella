import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider, useTranslations } from "use-intl";

import { Step, Steps } from "@stll/ui/steps";
import { IntFieldValue } from "@stll/workspace-ui/field-value";

import {
  FormattingProvider,
  stepsMarkerStyle,
  useFormatter,
  useFormattingLocale,
  useStepsMarkerStyle,
} from "@/i18n/formatting-context";
import {
  buildFormattingLocale,
  type NumberingPreference,
  supportedLanguages,
} from "@/i18n/i18n-store";
import messages from "@/i18n/langs/ar.json";
import { useMessageLocale } from "@/i18n/message-locale";

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

const StepsProbe = () => {
  const t = useTranslations("bilingualTranslate.dialog");
  return (
    <Steps markerStyle={useStepsMarkerStyle()}>
      <Step>{t("prepare")}</Step>
    </Steps>
  );
};

const numberingCases = {
  auto: { numberingSystem: "auto" },
  latn: { numberingSystem: "latn" },
  arab: { numberingSystem: "arab" },
} as const satisfies {
  [Preference in NumberingPreference]: { numberingSystem: Preference };
};

test.each(Object.values(numberingCases))(
  "Steps preserves the $numberingSystem preference across every supported language",
  ({ numberingSystem }) => {
    for (const lang of supportedLanguages) {
      const locale = buildFormattingLocale({
        lang,
        region: "SA",
        regionalFormat: "auto",
        calendar: "gregory",
        numberingSystem,
        weekStart: "auto",
      });
      let expectedSystem = numberingSystem;
      if (numberingSystem === "auto") {
        expectedSystem = lang === "ar" ? "arab" : "latn";
      }
      const number = new Intl.NumberFormat(locale).format(1);
      expect(number).toBe(expectedSystem === "arab" ? "١" : "1");
      const markerStyle =
        expectedSystem === "arab" ? "arabic-indic" : "decimal";
      expect(stepsMarkerStyle(locale)).toBe(markerStyle);
      const markup = renderToStaticMarkup(
        <IntlProvider locale="ar" messages={messages} timeZone="UTC">
          <FormattingProvider locale={locale} timeZone="UTC">
            <StepsProbe />
          </FormattingProvider>
        </IntlProvider>,
      );
      expect(markup).toContain("<ol");
      expect(markup).toContain(`list-style-type:${markerStyle}`);
    }
  },
);

test("Steps refuses an unsupported actual numbering system", () => {
  expect(() => stepsMarkerStyle("en-u-nu-deva")).toThrow(
    "Steps requires a supported formatting numbering system",
  );
});

const LocaleProbe = () => (
  <>
    {useMessageLocale()}
    {"|"}
    {useFormattingLocale()}
  </>
);

test("the UI language and the formatting locale are read separately", () => {
  const markup = renderToStaticMarkup(
    <IntlProvider locale="ar" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en-IN" timeZone="UTC">
        <LocaleProbe />
      </FormattingProvider>
    </IntlProvider>,
  );

  expect(markup).toBe("ar|en-IN");
});

test("the UI language must be a supported one", () => {
  expect(() =>
    renderToStaticMarkup(
      <IntlProvider locale="xx" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en-IN" timeZone="UTC">
          <LocaleProbe />
        </FormattingProvider>
      </IntlProvider>,
    ),
  ).toThrow("IntlProvider must be given a supported UI language");
});

test("workspace-ui components format in the formatting locale", () => {
  const markup = renderToStaticMarkup(
    <IntlProvider locale="ar" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en-IN" timeZone="UTC">
        <IntFieldValue
          content={{ type: "int", version: 1, value: 100_000, currency: null }}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

  expect(markup).toContain("1,00,000");
});
