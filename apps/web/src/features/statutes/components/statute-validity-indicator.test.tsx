import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { StatuteValidityIndicator } from "@/features/statutes/components/statute-validity-indicator";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

const renderWithIntl = (children: ReactNode) =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        {children}
      </FormattingProvider>
    </IntlProvider>,
  );

const EFFECTIVE = {
  expressionKind: "consolidation",
  windowDisposition: "effective",
} as const;

describe("statute validity indicator", () => {
  test("a version that cannot apply is named for what it is, never drawn as in force", () => {
    const markup = renderWithIntl(
      <StatuteValidityIndicator
        expression={{
          expressionKind: "consolidation",
          windowDisposition: "invalid-window",
        }}
        status="current"
        validFrom="2022-01-01"
        validTo="2021-12-31"
      />,
    );

    expect(markup).toContain(messages.statutes.expression.invalidWindow);
    expect(markup).not.toContain(messages.statutes.status.current);
    expect(markup).not.toContain("bg-success");
    expect(markup).toContain("Dates stated by the publisher:");
  });

  test("current text is explicit and carries the success dot", () => {
    const markup = renderWithIntl(
      <StatuteValidityIndicator
        expression={EFFECTIVE}
        status="current"
        validFrom="2021-10-01"
        validTo={null}
      />,
    );

    expect(markup).toContain(messages.statutes.status.current);
    expect(markup).toContain("bg-success");
    expect(markup).toContain("Oct 1, 2021");
  });

  test("superseded text is explicit and carries the warning dot", () => {
    const markup = renderWithIntl(
      <StatuteValidityIndicator
        expression={EFFECTIVE}
        status="historical"
        validFrom="1999-01-01"
        validTo="2021-10-01"
      />,
    );

    expect(markup).toContain(messages.statutes.status.historical);
    expect(markup).toContain("bg-warning");
    expect(markup).toContain("Sep 30, 2021");
  });

  test("future text carries its own informational dot", () => {
    const markup = renderWithIntl(
      <StatuteValidityIndicator
        expression={EFFECTIVE}
        status="historical"
        validFrom="2999-01-01"
        validTo={null}
      />,
    );

    expect(markup).toContain(messages.statutes.status.future);
    expect(markup).toContain("bg-info");
  });
});
