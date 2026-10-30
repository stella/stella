import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { LEGISLATION_WINDOW_DISPOSITIONS } from "@stll/api-contract/legislation-expression";
import MCP_APP_MESSAGES from "@stll/api-contract/mcp-app-messages";

import type { ProvisionVersion, StatuteTimelineHistory } from "./parse";
import { TimelineChart, VersionLabel } from "./presentation";

const historical = {
  url: null,
  documentId: "historical-version",
  resourceName: "historical-resource",
  versionValidFrom: "2020-01-01",
  versionValidTo: "2021-01-01",
  expressionKind: "consolidation",
  windowDisposition: "effective",
  windowDispositionBasis: null,
  status: "found",
  nextTextCursor: null,
  text: "Historical wording",
  truncated: false,
} as const satisfies ProvisionVersion;

describe("version disposition presentation", () => {
  test("distinguishes effective history from every non-effective window in the list and chart", () => {
    const items = LEGISLATION_WINDOW_DISPOSITIONS.map((windowDisposition) => ({
      ...historical,
      documentId: windowDisposition,
      windowDisposition,
    }));
    const history = {
      eli: "eli:example",
      anchor: "article-1",
      items,
      nextCursor: null,
    } satisfies StatuteTimelineHistory;
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" timeZone="UTC" messages={MCP_APP_MESSAGES.en}>
        {items.map((version) => (
          <VersionLabel key={version.documentId} version={version} />
        ))}
        <TimelineChart
          history={history}
          today="2025-01-01"
          onSelect={() => {}}
        />
      </IntlProvider>,
    );
    for (const disposition of LEGISLATION_WINDOW_DISPOSITIONS) {
      expect(markup).toContain(`data-window-disposition="${disposition}"`);
    }
    expect(markup).toContain("Consolidated wording · Effective window");
    expect(markup).toContain("Consolidated wording · Never in force");
    expect(markup).toContain("Consolidated wording · Withdrawn");
    expect(markup).toContain("Consolidated wording · Invalid validity window");
    expect(markup.match(/border-dashed/gu)).toHaveLength(3);
    expect(markup.match(/<rect[^>]+fill="none"/gu)).toHaveLength(3);
    expect(markup).toMatch(
      /<rect[^>]+effective[^>]+fill="var\(--foreground\)"[^>]+fill-opacity="0.3"/u,
    );
  });

  test("localizes the kind and disposition in every supported locale", () => {
    const promulgated = {
      ...historical,
      expressionKind: "promulgated",
      windowDisposition: "withdrawn",
    } as const satisfies ProvisionVersion;
    for (const [locale, messages] of Object.entries(MCP_APP_MESSAGES)) {
      const markup = renderToStaticMarkup(
        <IntlProvider locale={locale} timeZone="UTC" messages={messages}>
          <VersionLabel version={promulgated} />
        </IntlProvider>,
      );
      expect(markup).toContain(messages.timelineKindPromulgated);
      expect(markup).toContain(messages.timelineDispositionWithdrawn);
      expect(markup).toContain("border-dashed");
    }
  });
});
