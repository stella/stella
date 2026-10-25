import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { OAuthClientDetails } from "@/components/oauth-consent/oauth-client-details";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";

describe("consent app details", () => {
  test.each([
    ["en", en],
    ["ar", ar],
  ] as const)(
    "keeps destination details behind a localized info button in %s",
    (locale, messages) => {
      const markup = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <OAuthClientDetails
            clientName="Example connector"
            redirectUri={null}
            info={{
              client_name: "Example connector",
              redirectTargets: ["connector.example"],
              clientIdHost: "identity.example",
              unverified: true,
              verifiedBrand: null,
            }}
          />
        </IntlProvider>,
      );
      expect(markup).not.toContain("<bdi>connector.example</bdi>");
      expect(markup).not.toContain("<bdi>identity.example</bdi>");
      expect(markup).toContain(messages.consent.destinationDetails);
    },
  );
});
