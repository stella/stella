import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { DECISION_DATE_VERSION_BASIS } from "@stll/api-contract/provision-version-basis";

import { FormattingProvider } from "@/i18n/formatting-context";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";

import { ProvisionVersionBasisLabel } from "./provision-version-basis";

for (const [locale, messages] of [
  ["en", en],
  ["ar", ar],
] as const) {
  test(`inferred provision versions disclose their basis in ${locale}`, () => {
    const markup = renderToStaticMarkup(
      <IntlProvider
        locale={locale}
        messages={messages}
        timeZone="Europe/Prague"
      >
        <FormattingProvider locale={locale} timeZone="Europe/Prague">
          <ProvisionVersionBasisLabel basis={DECISION_DATE_VERSION_BASIS} />
        </FormattingProvider>
      </IntlProvider>,
    );
    expect(markup).toContain(
      messages.caseLaw.viewer.versionAtDecisionDateInferred,
    );
  });
}
