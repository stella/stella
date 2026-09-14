import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { MissingDecisionBody } from "@/features/case-law/components/case-viewer/decision-body-state";
import { MISSING_BODY_REASON } from "@/features/case-law/components/case-viewer/decision-body-state.logic";
import type { MissingBodyReason } from "@/features/case-law/components/case-viewer/decision-body-state.logic";
import messages from "@/i18n/langs/en.json";

const renderPane = (reason: MissingBodyReason): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <MissingDecisionBody onRetry={() => undefined} reason={reason} />
    </IntlProvider>,
  );

describe("MissingDecisionBody", () => {
  test("a failed read says so, and offers to ask again", () => {
    const markup = renderPane(MISSING_BODY_REASON.readFailed);

    expect(markup).toContain(messages.caseLaw.viewer.textReadFailed);
    expect(markup).toContain(messages.common.retry);
  });

  test("a document still being fetched says that instead", () => {
    const markup = renderPane(MISSING_BODY_REASON.pending);

    expect(markup).toContain(messages.caseLaw.viewer.textPending);
    expect(markup).toContain(messages.common.retry);
  });

  test("a decision the publisher offers no text for has nothing to retry", () => {
    const markup = renderPane(MISSING_BODY_REASON.unavailable);

    expect(markup).toContain(messages.caseLaw.viewer.textUnavailable);
    expect(markup).not.toContain(messages.common.retry);
  });

  // The list page's "configure a source and run a sync" line used to stand
  // here, telling a reader of one decision to go administer an import.
  test("never the case-law list's empty state", () => {
    for (const reason of Object.values(MISSING_BODY_REASON)) {
      expect(renderPane(reason)).not.toContain(messages.caseLaw.emptyState);
    }
  });
});
