import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { IntlProvider } from "use-intl";

import {
  type OAuthConsentClient,
  VERIFIED_OAUTH_CLIENT_BRANDS,
} from "@stll/api-contract";

import {
  ConsentClientTiles,
  ConsentClientVerification,
} from "@/components/oauth-consent/client-identity";
import { resolveConsentClientIdentity } from "@/components/oauth-consent/client-identity.logic";
import { ConsentCard } from "@/components/oauth-consent/consent-card";
import en from "@/i18n/langs/en.json";
import type { OAuthConsentInfo } from "@/lib/oauth-provider";
import { ConsentSuccess } from "@/routes/-consent-success";

const FALLBACK_NAME = en.consent.defaultClientName;
const VERIFIED_MARK = 'data-slot="verified-client-mark"';
const UNVERIFIED_MARK = 'data-slot="unverified-client-mark"';

const info = (client: OAuthConsentClient): OAuthConsentInfo => ({
  client,
  redirectTargets: ["connector.example"],
  clientIdHost: null,
});

const renderEn = (node: ReactNode) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      {node}
    </IntlProvider>,
  );

const renderCardHeader = (client: OAuthConsentClient) => {
  const identity = resolveConsentClientIdentity(info(client), FALLBACK_NAME);
  return renderEn(
    <>
      <ConsentClientTiles identity={identity} />
      <ConsentClientVerification identity={identity} />
    </>,
  );
};

const renderSuccess = (client: OAuthConsentClient) =>
  renderEn(
    <ConsentSuccess
      identity={resolveConsentClientIdentity(info(client), FALLBACK_NAME)}
      redirectUrl="https://connector.example/callback?code=example"
    />,
  );

describe("consent client identity", () => {
  test("the CLI metadata document renders Connect stella CLI to stella", async () => {
    const consentInfo = {
      client: { type: "verified", brand: "stella_cli" },
      redirectTargets: ["127.0.0.1", "localhost"],
      clientIdHost: "stella.example",
    } as const satisfies OAuthConsentInfo;
    const dom = new Window();
    try {
      // safe-html: React renderToStaticMarkup escapes the fixed consent fixture through renderEn.
      dom.document.body.innerHTML = renderEn(
        <ConsentCard
          identity={resolveConsentClientIdentity(consentInfo, FALLBACK_NAME)}
          details={null}
          decision={null}
        >
          {null}
        </ConsentCard>,
      );
      expect(dom.document.querySelectorAll("h1")).toHaveLength(1);
      expect(dom.document.querySelector("h1")?.textContent).toBe(
        "Connect stella CLI to stella",
      );
    } finally {
      await dom.happyDOM.close();
    }
  });

  test("a verified client shows its product, publisher and mark", () => {
    for (const [brand, name, publisher] of [
      ["claude", "Claude", "Anthropic"],
      ["claude_code", "Claude Code", "Anthropic"],
      ["chatgpt", "ChatGPT", "OpenAI"],
      ["codex", "Codex", "OpenAI"],
    ] as const) {
      const client = { type: "verified", brand } as const;
      expect(resolveConsentClientIdentity(info(client), FALLBACK_NAME)).toEqual(
        { type: "verified", brand, name, publisher },
      );
      const markup = renderCardHeader(client);
      expect(markup).toContain(VERIFIED_MARK);
      expect(markup).not.toContain(UNVERIFIED_MARK);
      expect(markup).toContain(`Verified app by ${publisher}`);
      expect(markup).not.toContain(en.consent.unverifiedApp);
    }
  });

  test("verified first-party documents name their own products", () => {
    for (const [brand, name] of [
      ["stella", "stella"],
      ["stella_ios", "stella for iOS"],
      ["stella_cli", "stella CLI"],
    ] as const) {
      const client = { type: "verified", brand } as const;
      expect(resolveConsentClientIdentity(info(client), FALLBACK_NAME)).toEqual(
        { type: "verified", brand, name, publisher: "stella" },
      );
      const markup = renderCardHeader(client);
      expect(markup).toContain("Verified app by stella");
      expect(markup).not.toContain(UNVERIFIED_MARK);
      expect(renderSuccess(client)).toContain(`Connected to ${name}`);
    }
  });

  test.each(["Claude", "stella", "stella CLI", "stella-cli"])(
    "an unverified client claiming %s shows no branding",
    (name) => {
      const client = { type: "unverified", name } as const;
      expect(resolveConsentClientIdentity(info(client), FALLBACK_NAME)).toEqual(
        {
          type: "unverified",
          name,
        },
      );
      const markup = renderCardHeader(client);
      expect(markup).toContain(en.consent.unverifiedApp);
      expect(markup).not.toContain("Verified app by");
      expect(markup).not.toContain(VERIFIED_MARK);
      expect(markup).toContain(UNVERIFIED_MARK);
    },
  );

  test("a client without a registered name gets the default name", () => {
    expect(
      resolveConsentClientIdentity(
        info({ type: "unverified", name: null }),
        FALLBACK_NAME,
      ),
    ).toEqual({ type: "unverified", name: FALLBACK_NAME });
    expect(
      resolveConsentClientIdentity(
        info({ type: "verified_unbranded", name: null }),
        FALLBACK_NAME,
      ),
    ).toEqual({ type: "verified_unbranded", name: FALLBACK_NAME });
  });

  test("absent identity data makes no verification claim", () => {
    for (const absent of [null, undefined]) {
      const identity = resolveConsentClientIdentity(absent, FALLBACK_NAME);
      expect(identity).toEqual({ type: "unknown", name: FALLBACK_NAME });
      const markup = renderEn(
        <>
          <ConsentClientTiles identity={identity} />
          <ConsentClientVerification identity={identity} />
        </>,
      );
      expect(markup).not.toContain(en.consent.unverifiedApp);
      expect(markup).not.toContain("Verified app by");
      expect(markup).not.toContain(VERIFIED_MARK);
    }
  });

  test("verified evidence without one product shows no product", () => {
    const client = {
      type: "verified_unbranded",
      name: "Example connector",
    } as const;
    expect(resolveConsentClientIdentity(info(client), FALLBACK_NAME)).toEqual({
      type: "verified_unbranded",
      name: "Example connector",
    });
    const markup = renderCardHeader(client);
    expect(markup).not.toContain("Verified app by");
    expect(markup).not.toContain(en.consent.unverifiedApp);
    expect(markup).not.toContain(VERIFIED_MARK);
  });

  test("every brand the server can name has an identity", () => {
    for (const brand of VERIFIED_OAUTH_CLIENT_BRANDS) {
      const identity = resolveConsentClientIdentity(
        info({ type: "verified", brand }),
        FALLBACK_NAME,
      );
      expect(identity.type).toBe("verified");
      expect(identity.name).not.toBe(FALLBACK_NAME);
    }
  });
});

describe("consent success", () => {
  test("a verified client keeps its mark and product name", () => {
    const markup = renderSuccess({ type: "verified", brand: "claude" });
    expect(markup).toContain(VERIFIED_MARK);
    expect(markup).not.toContain(UNVERIFIED_MARK);
    expect(markup).toContain("Connected to Claude");
    expect(markup).toContain(en.consent.returnToAgent);
  });

  test("an unverified client keeps the neutral mark and its claimed name", () => {
    const markup = renderSuccess({ type: "unverified", name: "Claude" });
    expect(markup).toContain(UNVERIFIED_MARK);
    expect(markup).not.toContain(VERIFIED_MARK);
    expect(markup).toContain("Connected to Claude");
  });
});
