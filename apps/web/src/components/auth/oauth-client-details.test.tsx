import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { OAuthClientDetails } from "@/components/auth/oauth-client-details";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";

describe("consent app details", () => {
  test.each([
    ["en", en],
    ["ar", ar],
  ] as const)(
    "shows the app destination and status in %s",
    (locale, messages) => {
      const markup = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <OAuthClientDetails
            info={{
              client_name: "Example connector",
              redirectHosts: ["connector.example"],
              clientIdHost: "identity.example",
              unverified: true,
            }}
          />
        </IntlProvider>,
      );
      expect(markup).toContain("<bdi>connector.example</bdi>");
      expect(markup).toContain("<bdi>identity.example</bdi>");
      expect(markup).toContain(messages.consent.unverifiedApp);
    },
  );

  test("omits the marker for verified apps", () => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <OAuthClientDetails
          info={{
            client_name: "Example connector",
            redirectHosts: ["stella.example"],
            clientIdHost: null,
            unverified: false,
          }}
        />
      </IntlProvider>,
    );
    expect(markup).not.toContain(en.consent.unverifiedApp);
  });
});
