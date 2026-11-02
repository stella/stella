import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { StatuteStatusPill } from "@/features/statutes/components/statute-status-pill";
import { STATUTE_STATUSES } from "@/features/statutes/statute-status";
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

describe("StatuteStatusPill", () => {
  // Declared set equals rendered set: a status added to the corpus list
  // without a label fails the `satisfies` check, and a label quietly mapped
  // onto another status fails here.
  test("every declared status renders its own label", () => {
    const labels = STATUTE_STATUSES.map((status) =>
      renderWithIntl(<StatuteStatusPill status={status} />),
    );

    for (const [index, status] of STATUTE_STATUSES.entries()) {
      expect(labels[index]).toContain(messages.statutes.status[status]);
    }

    expect(new Set(labels).size).toBe(STATUTE_STATUSES.length);
  });

  test("an unknown status is shown verbatim rather than dropped", () => {
    const markup = renderWithIntl(<StatuteStatusPill status="rescinded" />);

    expect(markup).toContain("rescinded");
  });
});
