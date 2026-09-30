import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { loadLocaleMessages, supportedLanguages } from "@/i18n/i18n-store";
import { PublicDecisionTextNotice } from "@/routes/law/-components/public-decision-text-notice";

test("the text notice and publisher link render on the server in every locale", async () => {
  for (const locale of supportedLanguages) {
    const messages = await loadLocaleMessages(locale);
    const markup = renderToStaticMarkup(
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <PublicDecisionTextNotice sourceUrl="https://example.com/decision" />
      </IntlProvider>,
    );
    expect(markup).toContain('href="https://example.com/decision"');
    expect(markup).not.toContain("caseLaw.viewer.textNotYetAvailable");
    expect(markup).toContain("<p");
  }
});

test("unsafe publisher links are omitted while the notice remains", async () => {
  const messages = await loadLocaleMessages("en");
  for (const sourceUrl of [null, "data:text/plain,blocked"]) {
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <PublicDecisionTextNotice sourceUrl={sourceUrl} />
      </IntlProvider>,
    );
    expect(markup).not.toContain("href=");
    expect(markup).toContain("The court has not published");
  }
});
