import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { VERIFIED_OAUTH_CLIENT_BRANDS } from "@stll/api-contract";

import {
  ConsentClientTiles,
  ConsentClientVerification,
} from "@/components/oauth-consent/client-identity";
import { resolveConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import en from "@/i18n/langs/en.json";
import type { OAuthConsentInfo } from "@/lib/oauth-provider";

const info = (overrides: Partial<OAuthConsentInfo>): OAuthConsentInfo => ({
  client_name: "Claude",
  redirectTargets: ["connector.example"],
  clientIdHost: null,
  unverified: true,
  verifiedBrand: null,
  ...overrides,
});

const render = (consentInfo: OAuthConsentInfo) => {
  const identity = resolveConsentClientIdentity(
    consentInfo,
    consentInfo.client_name ?? "An application",
  );
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <ConsentClientTiles identity={identity} />
      <ConsentClientVerification identity={identity} />
    </IntlProvider>,
  );
};

describe("consent client identity", () => {
  test("a verified client shows its product, publisher and mark", () => {
    for (const [brand, name, publisher] of [
      ["claude", "Claude", "Anthropic"],
      ["claude_code", "Claude Code", "Anthropic"],
      ["chatgpt", "ChatGPT", "OpenAI"],
      ["codex", "Codex", "OpenAI"],
    ] as const) {
      const consentInfo = info({
        client_name: "Whatever it registered",
        unverified: false,
        verifiedBrand: brand,
      });
      expect(
        resolveConsentClientIdentity(consentInfo, "Whatever it registered"),
      ).toEqual({ type: "verified", brand, name, publisher });
      const markup = render(consentInfo);
      expect(markup).toContain('data-slot="verified-client-mark"');
      expect(markup).toContain(`Verified app by ${publisher}`);
      expect(markup).not.toContain(en.consent.unverifiedApp);
    }
  });

  test("an unverified client claiming a product name shows no branding", () => {
    const consentInfo = info({ client_name: "Claude" });
    expect(resolveConsentClientIdentity(consentInfo, "Claude")).toEqual({
      type: "unverified",
      name: "Claude",
    });
    const markup = render(consentInfo);
    expect(markup).toContain(en.consent.unverifiedApp);
    expect(markup).not.toContain("Verified app by");
    expect(markup).not.toContain('data-slot="verified-client-mark"');
    expect(markup).toContain('data-slot="unverified-client-mark"');
    expect(markup).not.toContain(">C</div>");
  });

  test("absent identity data makes no verification claim", () => {
    for (const absent of [null, undefined]) {
      const identity = resolveConsentClientIdentity(
        absent,
        "Example connector",
      );
      expect(identity).toEqual({ type: "unknown", name: "Example connector" });
      const markup = renderToStaticMarkup(
        <IntlProvider locale="en" messages={en} timeZone="UTC">
          <ConsentClientTiles identity={identity} />
          <ConsentClientVerification identity={identity} />
        </IntlProvider>,
      );
      expect(markup).not.toContain(en.consent.unverifiedApp);
      expect(markup).not.toContain("Verified app by");
      expect(markup).not.toContain('data-slot="verified-client-mark"');
    }
  });

  test("verified evidence without one product shows no product", () => {
    const consentInfo = info({
      client_name: "Example connector",
      unverified: false,
      verifiedBrand: null,
    });
    expect(
      resolveConsentClientIdentity(consentInfo, "Example connector"),
    ).toEqual({ type: "verified_unbranded", name: "Example connector" });
    const markup = render(consentInfo);
    expect(markup).not.toContain("Verified app by");
    expect(markup).not.toContain(en.consent.unverifiedApp);
    expect(markup).not.toContain('data-slot="verified-client-mark"');
  });

  test("every brand the server can name has an identity", () => {
    for (const brand of VERIFIED_OAUTH_CLIENT_BRANDS) {
      const identity = resolveConsentClientIdentity(
        info({ unverified: false, verifiedBrand: brand }),
        "Claimed",
      );
      expect(identity.type).toBe("verified");
      expect(identity.name).not.toBe("Claimed");
    }
  });
});
