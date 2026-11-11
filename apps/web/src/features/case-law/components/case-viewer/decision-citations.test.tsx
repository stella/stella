import { renderToStaticMarkup } from "react-dom/server";

import { expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { UnresolvedCitationRow } from "@/features/case-law/components/case-viewer/decision-citations";
import messages from "@/i18n/langs/en.json";

test("an unresolved citation with unavailable text displays its empty state", () => {
  const markup = renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <UnresolvedCitationRow
        item={{
          citationText: null,
          textIncompleteReason: null,
          textWithheldReason: "source_licence",
        }}
      />
    </IntlProvider>,
  );

  expect(markup).toContain(messages.inspector.review.passageUnavailable);
  expect(markup).toContain(messages.caseLaw.citation.unresolved);
  expect(markup).toContain('data-text-unavailable-reason="source_licence"');
});
