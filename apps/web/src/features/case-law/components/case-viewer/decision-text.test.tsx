import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import type { DocumentAst } from "@stll/legal-ast/document-ast";

import { DecisionText } from "@/features/case-law/components/case-viewer/decision-text";
import { editorialSupplementBlocks } from "@/features/case-law/components/case-viewer/decision-text.logic";
import messages from "@/i18n/langs/en.json";

const ast = {
  blocks: [
    {
      anchorId: "p-1",
      id: "body",
      inlines: [{ text: "Court text.", type: "text" }],
      plainText: "Court text.",
      type: "paragraph",
    },
  ],
  metadata: {
    caseNumber: "1 As 1/2026",
    court: "Test court",
    decisionDate: null,
    decisionType: "Judgment",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
  version: 1,
} as const satisfies DocumentAst;

const renderDecision = (abstract: string): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DecisionText
        activeMatchIndex={-1}
        decision={{
          caseNumber: "1 As 1/2026",
          court: "Test court",
          documentAst: ast,
          documentPending: false,
          documentReadFailed: false,
          documentUnavailable: false,
          fulltext: null,
          id: "9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          language: "cs",
          sourceAttributionUrl: "https://rozhodnuti.nsoud.cz/detail/1",
          textFields: {
            abstract: { text: abstract, type: TEXT_FIELD_TYPE.PRESENT },
            headnote: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
            legalSentence: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
            summary: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
          },
        }}
        searchQuery=""
      />
    </IntlProvider>,
  );

describe("editorial legal text annotations", () => {
  test("every rendered source block has a stable selection anchor", () => {
    const abstract =
      "Analytická právní věta\n\nText with http://example.test/source.";
    const markup = renderDecision(abstract);

    for (const block of editorialSupplementBlocks(abstract)) {
      expect(markup).toContain(
        `data-anchor="supplement-abstract:${String(block.start)}"`,
      );
    }
    expect(markup).toContain('href="http://example.test/source"');
    expect(markup).not.toContain(messages.caseLaw.viewer.provisionsCited);
  });
});

// The abstract and the legal sentence are published beside the decision, not
// inside its document, so an unreadable document does not take them with it.
describe("a decision whose text did not resolve", () => {
  const renderBodyless = (): string =>
    renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <QueryClientProvider client={new QueryClient()}>
          <DecisionText
            activeMatchIndex={-1}
            decision={{
              caseNumber: "1 As 1/2026",
              court: "Test court",
              documentAst: null,
              documentPending: true,
              documentReadFailed: true,
              documentUnavailable: false,
              fulltext: null,
              id: "9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
              language: "cs",
              sourceAttributionUrl: null,
              textFields: {
                abstract: {
                  text: "Analytická právní věta o náhradě škody.",
                  type: TEXT_FIELD_TYPE.PRESENT,
                },
                headnote: {
                  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
                  type: TEXT_FIELD_TYPE.ABSENT,
                },
                legalSentence: {
                  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
                  type: TEXT_FIELD_TYPE.ABSENT,
                },
                summary: {
                  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
                  type: TEXT_FIELD_TYPE.ABSENT,
                },
              },
            }}
            searchQuery=""
          />
        </QueryClientProvider>
      </IntlProvider>,
    );

  test("says the text could not be read, and offers to ask again", () => {
    const markup = renderBodyless();

    expect(markup).toContain(messages.caseLaw.viewer.textReadFailed);
    expect(markup).toContain(messages.common.retry);
    // The case-law list's "configure a source and run a sync" line used to
    // stand here, telling a reader of one decision to go administer an import.
    expect(markup).not.toContain(messages.caseLaw.emptyState);
  });

  test("keeps the editorial supplement the record still carries", () => {
    expect(renderBodyless()).toContain(
      "Analytická právní věta o náhradě škody.",
    );
  });
});

describe("source attribution", () => {
  const markup = renderDecision("Analytická právní věta");

  test("closes the decision with a link to the publisher", () => {
    expect(markup).toContain('href="https://rozhodnuti.nsoud.cz/detail/1"');
    expect(markup).toContain("rozhodnuti.nsoud.cz");
    expect(markup.indexOf("Court text.")).toBeLessThan(
      markup.indexOf("rozhodnuti.nsoud.cz"),
    );
  });

  // Annotations anchor on `data-anchor` and quotations drop
  // `data-reader-chrome`, so the line can be neither highlighted, cited, nor
  // pulled into a passage copied from the end of the decision.
  test("stays out of the annotatable text", () => {
    const footer = markup.slice(markup.indexOf("<footer"));

    expect(footer).toContain("data-reader-chrome");
    expect(footer).not.toContain("data-anchor");
  });
});

// A results row sends the reader to one passage for one reason: it holds the
// words they searched for. Both facts have to survive the trip — the words
// marked through the reader's own find, the passage marked in a way that
// outlives an arrival flash.
const searchedAst = {
  blocks: [
    {
      anchorId: "p-1",
      id: "b-1",
      inlines: [
        { text: "The appellant relied on the contract.", type: "text" },
      ],
      plainText: "The appellant relied on the contract.",
      type: "paragraph",
    },
    {
      anchorId: "p-2",
      id: "b-2",
      inlines: [{ text: "The contract was void.", type: "text" }],
      plainText: "The contract was void.",
      type: "paragraph",
    },
    {
      anchorId: "p-3",
      id: "b-3",
      inlines: [{ text: "Costs follow the event.", type: "text" }],
      plainText: "Costs follow the event.",
      type: "paragraph",
    },
  ],
  metadata: {
    caseNumber: "1 As 1/2026",
    court: "Test court",
    decisionDate: null,
    decisionType: "Judgment",
    ecli: null,
    keywords: [],
    statutes: [],
  },
  source: { documentId: "1", printUrl: "", system: "test", webUrl: "" },
  version: 1,
} as const satisfies DocumentAst;

const renderSearchedDecision = ({
  activeMatchIndex,
  landingAnchorId,
}: {
  activeMatchIndex: number;
  landingAnchorId?: string | undefined;
}): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DecisionText
        activeMatchIndex={activeMatchIndex}
        decision={{
          caseNumber: "1 As 1/2026",
          court: "Test court",
          documentAst: searchedAst,
          documentPending: false,
          documentReadFailed: false,
          documentUnavailable: false,
          fulltext: null,
          id: "9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          language: "en",
          sourceAttributionUrl: null,
          textFields: {
            abstract: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
            headnote: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
            legalSentence: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
            summary: {
              reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
              type: TEXT_FIELD_TYPE.ABSENT,
            },
          },
        }}
        landingAnchorId={landingAnchorId}
        searchQuery="contract"
      />
    </IntlProvider>,
  );

const activeMatchIndexOf = (markup: string): number | null => {
  const active =
    /<mark class="[^"]*ring-warning[^"]*" data-reader-match-index="(?<index>\d+)"/u.exec(
      markup,
    )?.groups?.["index"];
  return active === undefined ? null : Number(active);
};

describe("a decision opened from a search result", () => {
  test("the query's words are marked and the landing passage holds the active match", () => {
    const markup = renderSearchedDecision({
      activeMatchIndex: 0,
      landingAnchorId: "p-2",
    });

    expect(markup).toContain('data-reader-match-index="0"');
    expect(markup).toContain('data-reader-match-index="1"');
    expect(activeMatchIndexOf(markup)).toBe(1);
  });

  test("without a landing passage the find keeps its own position", () => {
    expect(
      activeMatchIndexOf(renderSearchedDecision({ activeMatchIndex: 0 })),
    ).toBe(0);
  });

  // A question's source chip names the block its answer came from, which the
  // query had no part in choosing. Activating the find's own position there
  // would mark an occurrence the reader never asked about, somewhere else
  // entirely; the passage they did ask for still carries its marker.
  test("a landing passage the query does not reach activates no match", () => {
    const markup = renderSearchedDecision({
      activeMatchIndex: 0,
      landingAnchorId: "p-3",
    });

    expect(markup).toContain('data-reader-match-index="0"');
    expect(activeMatchIndexOf(markup)).toBeNull();
    expect(markup).toContain('data-anchor="p-3" data-reader-landing=""');
  });

  test("the landing passage keeps a marker, and no other block takes one", () => {
    const markup = renderSearchedDecision({
      activeMatchIndex: 0,
      landingAnchorId: "p-2",
    });

    expect(markup).toContain('data-anchor="p-2" data-reader-landing=""');
    expect(markup).not.toContain('data-anchor="p-1" data-reader-landing=""');
  });
});
