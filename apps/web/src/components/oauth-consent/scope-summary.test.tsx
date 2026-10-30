import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { createTranslator, IntlProvider } from "use-intl";

import {
  MCP_ADVANCED_RESOURCE_SCOPES,
  MCP_OAUTH_PROTOCOL_SCOPES,
} from "@stll/api-contract";

import { ScopeSummary } from "@/components/oauth-consent/scope-summary";
import { FormattingProvider } from "@/i18n/formatting-context";
import ar from "@/i18n/langs/ar.json";
import en from "@/i18n/langs/en.json";
import {
  toOAuthScopeDisplayEntries,
  translateOAuthScopeEntry,
} from "@/lib/oauth-scopes";

describe("concise consent permissions", () => {
  test.each(["stella:feedback", "stella:onboarding"])(
    "describes %s without claiming document editing",
    (scope) => {
      const markup = renderToStaticMarkup(
        <IntlProvider locale="en" messages={en} timeZone="UTC">
          <FormattingProvider locale="en" timeZone="UTC">
            <ScopeSummary scopes={[scope]} />
          </FormattingProvider>
        </IntlProvider>,
      );
      expect(markup).toContain('data-slot="consent-permissions"');
      const summary = markup.slice(
        0,
        markup.indexOf('data-slot="consent-permissions"'),
      );
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
          <FormattingProvider locale={locale} timeZone="UTC">
            <ScopeSummary scopes={scopes} />
          </FormattingProvider>
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
        <FormattingProvider locale="en" timeZone="UTC">
          <ScopeSummary scopes={["stella:read", "vendor:custom"]} />
        </FormattingProvider>
      </IntlProvider>,
    );
    expect(markup).not.toContain('data-slot="consent-sensitive-access"');
    expect(markup).toContain("vendor:custom");
    expect(markup.match(/data-slot="consent-summary-line"/gu)).toHaveLength(2);
  });
});
