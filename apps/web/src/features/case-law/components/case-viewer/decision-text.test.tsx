import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import type {
  DocumentAst,
  ParagraphBlock,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";

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
        decisionId="dec-1"
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
            decisionId="dec-1"
            searchQuery=""
          />
        </QueryClientProvider>
      </IntlProvider>,
    );

  test("says the text could not be read, and offers to ask again", () => {
    const markup = renderBodyless();

    expect(markup).toContain("<article");
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
        decisionId="dec-1"
        landingAnchorId={landingAnchorId}
        searchQuery="contract"
      />
    </IntlProvider>,
  );

const BODY_TEXT = "Court text.";

type TextFieldOverrides = Partial<
  Record<"abstract" | "legalSentence" | "summary", string>
>;

const absent = {
  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  type: TEXT_FIELD_TYPE.ABSENT,
} as const;

const presentOr = (text: string | undefined) =>
  text === undefined ? absent : { text, type: TEXT_FIELD_TYPE.PRESENT };

/** The court's own paragraph, plus whatever publisher matter a case adds. */
const astWith = (blocks: readonly ParagraphBlock[]) => ({
  ...ast,
  blocks: [...ast.blocks, ...blocks],
});

const publisherParagraph = (
  id: string,
  role: ParagraphRole,
  text: string,
): ParagraphBlock => ({
  anchorId: id,
  id,
  inlines: [{ text, type: "text" }],
  plainText: text,
  role,
  type: "paragraph",
});

const renderTopMatter = ({
  documentAst = ast,
  fields = {},
  searchQuery = "",
}: {
  documentAst?: unknown;
  fields?: TextFieldOverrides;
  searchQuery?: string;
} = {}): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DecisionText
        activeMatchIndex={-1}
        decision={{
          caseNumber: "1 As 1/2026",
          court: "Test court",
          documentAst,
          documentPending: false,
          documentReadFailed: false,
          documentUnavailable: false,
          fulltext: null,
          id: "9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          language: "cs",
          sourceAttributionUrl: null,
          textFields: {
            abstract: presentOr(fields.abstract),
            headnote: absent,
            legalSentence: presentOr(fields.legalSentence),
            summary: presentOr(fields.summary),
          },
        }}
        decisionId="dec-1"
        searchQuery={searchQuery}
      />
    </IntlProvider>,
  );

/** Every match the page carries, in the order it draws them. */
const matchIndexesInOrder = (markup: string): number[] =>
  [...markup.matchAll(/data-reader-match-index="(?<index>\d+)"/gu)].map(
    (match) => Number(match.groups?.["index"]),
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

const occurrences = (markup: string, text: string): number =>
  markup.split(text).length - 1;

/** The `<details>` tag that opens the section labelled `label`. */
const disclosureOpening = (markup: string, label: string): string => {
  const labelAt = markup.indexOf(label);
  const openingAt = markup.lastIndexOf("<details", labelAt);
  return markup.slice(openingAt, markup.indexOf(">", openingAt) + 1);
};

describe("what a decision opens with", () => {
  const headnote = "Publisher headnote sentence.";

  test("lifts the parser's headnote paragraph above the court's text, once", () => {
    const markup = renderTopMatter({
      documentAst: astWith([publisherParagraph("p-h", "headnotes", headnote)]),
    });

    expect(occurrences(markup, headnote)).toBe(1);
    expect(markup.indexOf(headnote)).toBeLessThan(markup.indexOf(BODY_TEXT));
    // Its block id travels with it, so find, marks and the permalink still
    // address the paragraph where it now renders.
    expect(markup).toContain('id="p-h"');
    // Nothing is left for the head-matter disclosure to fold.
    expect(markup).not.toContain("reader-apparatus");
  });

  test("falls back to the legal-sentence field, then to the summary field", () => {
    const fromField = renderTopMatter({
      fields: { legalSentence: "Field sentence." },
    });

    expect(fromField.indexOf("Field sentence.")).toBeLessThan(
      fromField.indexOf(BODY_TEXT),
    );

    const fromSummary = renderTopMatter({
      fields: { summary: "Summary line." },
    });

    expect(fromSummary.indexOf("Summary line.")).toBeLessThan(
      fromSummary.indexOf(BODY_TEXT),
    );
    expect(fromSummary).toContain(messages.caseLaw.viewer.legalSentence);
  });

  test("prefers the marked paragraph to the field copied from it", () => {
    const markup = renderTopMatter({
      documentAst: astWith([publisherParagraph("p-h", "headnotes", headnote)]),
      fields: { legalSentence: "Field sentence." },
    });

    expect(markup).toContain(headnote);
    expect(markup).not.toContain("Field sentence.");
  });

  test("opens the headnote and folds the abstract, the same on both passes", () => {
    const markup = renderTopMatter({
      fields: {
        abstract: "Publisher abstract.",
        legalSentence: "Field sentence.",
      },
    });

    expect(
      disclosureOpening(markup, messages.caseLaw.viewer.legalSentence),
    ).toContain("open");
    expect(
      disclosureOpening(markup, messages.caseLaw.viewer.abstract),
    ).not.toContain("open");
  });

  // `buildSearchResults` numbers matches in piece order, so a page whose
  // blocks moved has to be indexed in the order it draws them; otherwise the
  // find walks backwards through it.
  test("numbers the find's matches in the order the page renders them", () => {
    const markup = renderTopMatter({
      documentAst: astWith([
        publisherParagraph("p-h", "headnotes", "Court reasoning, headnote."),
      ]),
      searchQuery: "court",
    });

    // The reference line, then the headnote, then the court's paragraph: the
    // headnote renders above the body even though the parser marked it
    // further down, and the numbering follows the page.
    expect(matchIndexesInOrder(markup)).toEqual([0, 1, 2]);
    // Compared on the anchors: the query's marks cut both texts into spans.
    expect(markup.indexOf('id="p-h"')).toBeLessThan(markup.indexOf('id="p-1"'));
  });

  // A note can carry any role, so a lifted section can hold one. Its mark
  // belongs on the first paragraph and its return arrow on the last, the way
  // the body draws them.
  test("keeps a lifted footnote's grouping", () => {
    const note = { label: "1", noteId: "n-1", type: "footnote" } as const;
    const markup = renderTopMatter({
      documentAst: astWith([
        { ...publisherParagraph("p-h1", "headnotes", "Note opens."), note },
        { ...publisherParagraph("p-h2", "headnotes", "Note continues."), note },
      ]),
    });

    expect(occurrences(markup, "reader-note-label")).toBe(1);
    expect(occurrences(markup, "reader-note-back")).toBe(1);
  });

  test("leaves the fold to what is neither headnote nor abstract", () => {
    const markup = renderTopMatter({
      documentAst: astWith([
        publisherParagraph("p-h", "headnotes", headnote),
        publisherParagraph("p-s", "syllabus", "Publisher syllabus."),
        publisherParagraph("p-c", "counsel", "For the applicant: counsel."),
      ]),
    });
    const fold = markup.slice(markup.indexOf("reader-apparatus"));

    expect(fold).toContain("For the applicant: counsel.");
    expect(fold).not.toContain(headnote);
    expect(fold).not.toContain("Publisher syllabus.");
    expect(occurrences(markup, "Publisher syllabus.")).toBe(1);
  });
});
