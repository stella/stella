import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { FormattingProvider } from "@/i18n/formatting-context";
import en from "@/i18n/langs/en.json";

import { AnalysisErrorNotice } from "./analysis-error-notice";

const renderUnavailable = (sourceUrl: string | null) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={en} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <AnalysisErrorNotice
          error={{ kind: "unavailable", code: "document_unparseable" }}
          sourceUrl={sourceUrl}
          onRetry={() => undefined}
        />
      </FormattingProvider>
    </IntlProvider>,
  );

test("unparseable decisions offer their safe original source without a futile retry", () => {
  const markup = renderUnavailable("https://example.org/decision/442");
  expect(markup).toContain(en.caseLaw.analysis.errors.documentUnparseable);
  expect(markup).toContain('href="https://example.org/decision/442"');
  expect(markup).toContain('rel="noopener noreferrer"');
  expect(markup).toContain(en.common.viewSource);
  expect(markup).not.toContain(en.common.retry);
});

test("missing or unsafe original source URLs never become active links", () => {
  for (const source of [
    null,
    ["javascript", "alert(1)"].join(":"),
    "data:text/html,unsafe",
  ]) {
    const markup = renderUnavailable(source);
    expect(markup).not.toContain("href=");
    expect(markup).not.toContain(en.common.viewSource);
    expect(markup).toContain(en.caseLaw.analysis.errors.documentUnparseable);
  }
});
