import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import { OAuthClientDetails } from "@/routes/consent/-components/oauth-client-details";

describe("consent app details", () => {
  test.each([
    ["en", en],
    ["ar", ar],
  ] as const)("shows where the app returns you in %s", (locale, messages) => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale={locale} messages={messages} timeZone="UTC">
        <OAuthClientDetails
          clientName="Example connector"
          redirectUri={null}
          info={{
            client_name: "Example connector",
            redirectHosts: ["connector.example"],
            clientIdHost: "identity.example",
            unverified: true,
            verifiedBrand: null,
          }}
        />
      </IntlProvider>,
    );
    expect(markup).toContain("<bdi>connector.example</bdi>");
    expect(markup).toContain("<bdi>identity.example</bdi>");
    expect(markup).toContain(messages.consent.destinationDetails);
  });

  test("names the publisher host of a discovered app", () => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <OAuthClientDetails
          clientName="Example connector"
          redirectUri={null}
          info={{
            client_name: "Example connector",
            redirectHosts: ["stella.example"],
            clientIdHost: "publisher.example",
            unverified: false,
            verifiedBrand: null,
          }}
        />
      </IntlProvider>,
    );
    expect(markup).toContain("Published by <bdi>publisher.example</bdi>");
  });
});
