import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { VERIFIED_OAUTH_CLIENT_BRANDS } from "@stll/api-contract";

import en from "@/i18n/langs/en.json";
import type { OAuthConsentInfo } from "@/lib/oauth-provider";
import {
  ConsentClientTiles,
  ConsentClientVerification,
} from "@/routes/consent/-components/client-identity";
import { resolveConsentClientIdentity } from "@/routes/consent/-components/client-identity.logic";

const info = (overrides: Partial<OAuthConsentInfo>): OAuthConsentInfo => ({
  client_name: "Claude",
  redirectHosts: ["connector.example"],
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

  test("a client calling itself a known assistant gets no branding", () => {
    for (const claimed of ["Claude", "Claude Code", "ChatGPT", "Codex"]) {
      const consentInfo = info({ client_name: claimed });
      expect(resolveConsentClientIdentity(consentInfo, claimed)).toEqual({
        type: "unverified",
        name: claimed,
      });
      const markup = render(consentInfo);
      expect(markup).toContain(en.consent.unverifiedApp);
      expect(markup).not.toContain("Verified app by");
      // The tile shows the claimed initial, never a product mark.
      expect(markup).not.toContain('data-slot="verified-client-mark"');
      expect(markup).toContain(`>${Array.from(claimed).at(0)}</div>`);
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
    expect(render(consentInfo)).toContain(en.common.verified);
  });

  test("a verified brand without a shipped mark shows its initial", () => {
    for (const [brand, initial] of [
      ["microsoft_copilot", "M"],
      ["copilot_studio", "C"],
      ["gemini_enterprise", "G"],
    ] as const) {
      const markup = render(info({ unverified: false, verifiedBrand: brand }));
      expect(markup).not.toContain('data-slot="verified-client-mark"');
      expect(markup).toContain(`>${initial}</div>`);
    }
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
