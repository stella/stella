import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { createTranslator, IntlProvider } from "use-intl";

import {
  ACCOUNT_EXPORT_SCOPES,
  MCP_ADVANCED_RESOURCE_SCOPES,
  MCP_OAUTH_PROTOCOL_SCOPES,
} from "@stll/api-contract";

import { ScopeSummary } from "@/components/oauth-consent/scope-summary";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import {
  toOAuthScopeDisplayEntries,
  translateOAuthScopeEntry,
} from "@/lib/oauth-scopes";

describe("concise consent permissions", () => {
  test("account export consent discloses both grants without claiming deletion", () => {
    const scopes = Object.values(ACCOUNT_EXPORT_SCOPES);
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <ScopeSummary scopes={scopes} />
      </IntlProvider>,
    );
    expect(markup).not.toContain('data-slot="consent-sensitive-access"');
    expect(markup).toContain(en.consent.scopeAccountExportRead);
    expect(markup).toContain(en.consent.scopeAccountExportWrite);
    expect(markup.match(/data-slot="consent-summary-line"/gu)).toHaveLength(2);
  });

  test.each(["stella:feedback", "stella:onboarding"])(
    "describes %s without claiming document editing",
    (scope) => {
      const markup = renderToStaticMarkup(
        <IntlProvider locale="en" messages={en} timeZone="UTC">
          <ScopeSummary scopes={[scope]} />
        </IntlProvider>,
      );
      expect(markup).toContain("<details");
      const summary = markup.slice(0, markup.indexOf("<details"));
      expect(summary).not.toContain("Create and edit:");
      expect(summary).toContain(
        renderToStaticMarkup(
          scope === "stella:feedback"
            ? en.consent.scopeFeedback
            : en.consent.scopeOnboarding,
        ),
      );
      expect(summary.match(/data-slot="consent-summary-line"/gu)).toHaveLength(
        1,
      );
    },
  );
  test.each([
    ["en", en],
    ["ar", ar],
  ] as const)(
    "summarizes scopes in four lines with one warning in %s",
    (locale, messages) => {
      const scopes = [
        ...MCP_ADVANCED_RESOURCE_SCOPES,
        ...MCP_OAUTH_PROTOCOL_SCOPES,
      ];
      const markup = renderToStaticMarkup(
        <IntlProvider locale={locale} messages={messages} timeZone="UTC">
          <ScopeSummary scopes={scopes} />
        </IntlProvider>,
      );
      expect(markup.match(/data-slot="consent-summary-line"/gu)).toHaveLength(
        4,
      );
      expect(
        markup.match(/data-slot="consent-sensitive-access"/gu),
      ).toHaveLength(1);
      expect(markup).toContain(messages.consent.summaryStaySignedIn);
      const entries = toOAuthScopeDisplayEntries(scopes);
      const t = createTranslator({
        locale,
        messages: { consent: messages.consent },
      });
      for (const entry of entries) {
        if (entry.type === "known") {
          expect(markup).toContain(
            renderToStaticMarkup(
              <bdi>{translateOAuthScopeEntry(t, entry)}</bdi>,
            ),
          );
        }
      }
    },
  );

  test("read-only and unknown grants show no destructive warning", () => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" messages={en} timeZone="UTC">
        <ScopeSummary scopes={["stella:read", "vendor:custom"]} />
      </IntlProvider>,
    );
    expect(markup).not.toContain('data-slot="consent-sensitive-access"');
    expect(markup).toContain("vendor:custom");
    expect(markup.match(/data-slot="consent-summary-line"/gu)).toHaveLength(2);
  });
});
