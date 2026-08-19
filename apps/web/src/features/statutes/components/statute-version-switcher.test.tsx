import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { StatuteStatusPill } from "@/features/statutes/components/statute-status-pill";
import { StatuteVersionSwitcher } from "@/features/statutes/components/statute-version-switcher";
import type { StatuteVersion } from "@/features/statutes/components/statute-version-switcher";
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

const currentVersion = {
  id: "00000000-0000-4000-8000-000000000002",
  versionValidFrom: "2020-01-01",
  versionValidTo: null,
} satisfies StatuteVersion;

const supersededVersion = {
  id: "00000000-0000-4000-8000-000000000001",
  versionValidFrom: "2014-01-01",
  versionValidTo: "2019-12-31",
} satisfies StatuteVersion;

const versions = [currentVersion, supersededVersion];

const noop = () => undefined;

describe("StatuteVersionSwitcher", () => {
  test("draws nothing for a work with a single version", () => {
    const markup = renderWithIntl(
      <StatuteVersionSwitcher
        currentVersionId={currentVersion.id}
        onVersionChange={noop}
        versions={[currentVersion]}
      />,
    );

    expect(markup).toBe("");
  });

  test("labels the selected version by its validity window", () => {
    const markup = renderWithIntl(
      <StatuteVersionSwitcher
        currentVersionId={currentVersion.id}
        onVersionChange={noop}
        versions={versions}
      />,
    );

    // An open-ended window must read as still in force, not as a missing date.
    expect(markup).toContain("Jan 1, 2020");
    expect(markup).toContain(messages.statutes.openEnded);
  });
});

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
