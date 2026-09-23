import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import { CitedDecisionPreview } from "@/components/legal-reader/cited-decision-link";
import { CitationPassageQuote } from "@/features/case-law/components/case-viewer/citation-passage-preview";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";

const decision = {
  caseNumber: "Pl. ÚS 36/08",
  country: "CZE",
  court: "Ústavní soud",
  decisionDate: "2009-04-08",
  decisionType: "Nález",
  id: "2c1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  language: "cs",
  languageAlternates: [],
  slug: "pl-us-36-08",
};

const render = (node: ReactNode): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        {node}
      </FormattingProvider>
    </IntlProvider>,
  );

describe("CitedDecisionPreview", () => {
  test("places the decision and offers opening it as the one action", () => {
    const markup = render(
      <CitedDecisionPreview decision={decision} onOpen={() => undefined} />,
    );

    expect(markup).toContain(decision.court);
    expect(markup).toContain(messages.caseLaw.citation.openDecision);
  });

  test("states how the citing text treats the decision", () => {
    const markup = render(
      <CitedDecisionPreview
        decision={decision}
        onOpen={() => undefined}
        treatment="negative"
      />,
    );

    expect(markup).toContain(messages.caseLaw.citation.treatment.negative);
  });

  test("says nothing about treatment where the citation carries none", () => {
    const markup = render(
      <CitedDecisionPreview decision={decision} onOpen={() => undefined} />,
    );

    // Every label, not a chosen few: a treatment added later cannot creep
    // into a preview that was given none.
    for (const label of Object.values(messages.caseLaw.citation.treatment)) {
      expect(markup).not.toContain(label);
    }
  });
});

describe("CitationPassageQuote", () => {
  const text = "Soud odkázal na nález Pl. ÚS 36/08 a převzal jeho závěry.";

  test("quotes the citing sentence with the citation set off", () => {
    const markup = render(
      <CitationPassageQuote
        read={{
          passage: {
            anchorId: "p-12",
            blockId: "b-12",
            end: text.indexOf("Pl. ÚS 36/08") + "Pl. ÚS 36/08".length,
            mention: "sole",
            start: text.indexOf("Pl. ÚS 36/08"),
            text,
          },
          status: "found",
        }}
      />,
    );

    expect(markup).toContain("Soud odkázal na nález");
    expect(markup).toContain("a převzal jeho závěry.");
    expect(markup).toContain("<blockquote");
  });

  test("says when the text does not carry the citation", () => {
    expect(
      render(
        <CitationPassageQuote read={{ passage: null, status: "absent" }} />,
      ),
    ).toContain(messages.caseLaw.citation.passageNotFound);
  });

  test("a failed read of the citing text says so rather than quoting nothing", () => {
    expect(
      render(
        <CitationPassageQuote read={{ passage: null, status: "failed" }} />,
      ),
    ).toContain(messages.errors.actionFailed);
  });
});
