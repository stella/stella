import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import type {
  DocumentAst,
  ParagraphBlock,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";

import { AiHeadnotes } from "@/features/case-law/components/case-viewer/analysis/ai-headnotes";
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
          judges: [],
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
      "Analytická právní věta\n\nText with https://rozhodnuti.nsoud.cz/source " +
      "and https://statutes.example.com/act.";
    const markup = renderDecision(abstract);

    for (const block of editorialSupplementBlocks(abstract)) {
      expect(markup).toContain(
        `data-anchor="supplement-abstract:${String(block.start)}"`,
      );
    }
    // The publisher's own address auto-links; an address outside the corpus
    // stays the words the court printed. See `source-link-policy.tsx`.
    expect(markup).toContain('href="https://rozhodnuti.nsoud.cz/source"');
    expect(markup).not.toContain('href="https://statutes.example.com/act"');
    expect(markup).toContain("https://statutes.example.com/act");
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
              judges: [],
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
          judges: [],
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
  analysis,
  courtAbbreviation,
  courtTier,
  documentAst = ast,
  fields = {},
  notesByAnchorId,
  searchQuery = "",
}: {
  analysis?: DecisionAnalysis;
  courtAbbreviation?: string;
  courtTier?: string;
  documentAst?: unknown;
  fields?: TextFieldOverrides;
  notesByAnchorId?: ReadonlyMap<string, ReactNode>;
  searchQuery?: string;
} = {}): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <DecisionText
        activeMatchIndex={-1}
        aiHeadnotes={
          analysis === undefined ? null : (
            <AiHeadnotes analysis={analysis} onAnchorClick={() => undefined} />
          )
        }
        decision={{
          caseNumber: "1 As 1/2026",
          court: "Test court",
          courtAbbreviation,
          courtTier,
          documentAst,
          documentPending: false,
          documentReadFailed: false,
          documentUnavailable: false,
          fulltext: null,
          id: "9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
          judges: [],
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
        notesByAnchorId={notesByAnchorId}
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

  // The paragraph moved, so its comment moves with it. Left behind, the note
  // would be drawn after the whole decision, under text it is not about.
  test("draws a note on a lifted paragraph under the paragraph", () => {
    const note = "Reader note.";
    const markup = renderTopMatter({
      documentAst: astWith([publisherParagraph("p-h", "headnotes", headnote)]),
      notesByAnchorId: new Map([["p-h", <span key="note">{note}</span>]]),
    });

    expect(occurrences(markup, note)).toBe(1);
    expect(markup.indexOf(note)).toBeLessThan(markup.indexOf(BODY_TEXT));
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

/** One section of the top matter: its `<details>` tag and all that follows. */
const sectionOf = (markup: string, text: string): string =>
  markup
    .split("<details")
    .slice(1)
    .find((section) => section.includes(text)) ?? "";

/** The attributes of the `<details>` that opens the section holding `text`. */
const sectionAttributes = (markup: string, text: string): string => {
  const section = sectionOf(markup, text);
  return section.slice(0, section.indexOf(">"));
};

/** The `<summary>` line of the section whose body contains `text`. */
const sectionSummary = (markup: string, text: string): string => {
  const section = sectionOf(markup, text);
  return section.slice(0, section.indexOf("</summary>"));
};

// Two authors write the same two sections, and a reader must be able to tell
// whose sentence they are reading — by the mark on it, never by a shape that
// would also rank one author above the other.
describe("a headnote the court wrote and one a model wrote", () => {
  const analysis = {
    version: 3,
    generatedAt: "2026-02-01T00:00:00.000Z",
    model: "test-model",
    inputFingerprint: "fingerprint-1",
    tree: [],
    holding: { anchors: [], language: "cs", text: "Model holding sentence." },
    abstract: { language: "cs", text: "Model abstract sentence." },
    topics: [],
  } satisfies DecisionAnalysis;
  const courtHeadnote = "Publisher headnote sentence.";
  const courtAbstract = "Publisher abstract sentence.";

  const markup = renderTopMatter({
    analysis,
    courtAbbreviation: "NS",
    courtTier: "supreme",
    fields: { abstract: courtAbstract, legalSentence: courtHeadnote },
  });

  test("draws both under one label and one shape", () => {
    const summaries = [...markup.matchAll(/<summary class="(?<cls>[^"]*)"/gu)]
      .map((match) => match.groups?.["cls"])
      .filter((cls) => cls !== undefined);

    // The court's two sections and the model's two, all styled alike.
    expect(summaries).toHaveLength(4);
    expect(new Set(summaries).size).toBe(1);
    expect(sectionSummary(markup, courtHeadnote)).toContain(
      messages.caseLaw.viewer.legalSentence,
    );
    expect(sectionSummary(markup, "Model holding sentence.")).toContain(
      messages.caseLaw.viewer.legalSentence,
    );
  });

  test("marks each section with who wrote it", () => {
    const court = sectionSummary(markup, courtHeadnote);
    const model = sectionSummary(markup, "Model holding sentence.");

    expect(court).toContain('data-slot="court-badge"');
    expect(court).toContain("NS");
    expect(court).not.toContain(messages.caseLaw.notesFilter.ai);
    expect(model).toContain(messages.caseLaw.notesFilter.ai);
    expect(model).not.toContain('data-slot="court-badge"');
  });

  test("opens with the court's own, then what the model made of it", () => {
    expect(markup.indexOf(courtHeadnote)).toBeLessThan(
      markup.indexOf("Model holding sentence."),
    );
    expect(markup.indexOf("Model holding sentence.")).toBeLessThan(
      markup.indexOf("Model abstract sentence."),
    );
    expect(markup.indexOf("Model abstract sentence.")).toBeLessThan(
      markup.indexOf("Court text."),
    );
  });

  // A section keeps the fold its kind has always had, whoever wrote it: a
  // headnote is what the reader came for, an abstract repeats the decision.
  // The court's abstract folds under its headnote; the model's abstract opens,
  // being the reader's way into a decision the court did not summarise.
  test("opens every block but the court's abstract", () => {
    expect(sectionAttributes(markup, courtHeadnote)).toContain("open");
    expect(sectionAttributes(markup, "Model holding sentence.")).toContain(
      "open",
    );
    expect(sectionAttributes(markup, courtAbstract)).not.toContain("open");
    expect(sectionAttributes(markup, "Model abstract sentence.")).toContain(
      "open",
    );
  });

  // The model's sentences are not the decision's words: they can be neither
  // highlighted, nor cited, nor pulled into a quotation of the text beside
  // them. The court's own keep all three.
  test("keeps the model's sentences out of the annotatable text", () => {
    expect(sectionAttributes(markup, "Model holding sentence.")).toContain(
      "data-reader-chrome",
    );
    expect(sectionOf(markup, "Model holding sentence.")).not.toContain(
      "data-anchor",
    );
    expect(sectionAttributes(markup, courtHeadnote)).not.toContain(
      "data-reader-chrome",
    );
    expect(sectionOf(markup, courtHeadnote)).toContain("data-anchor");
  });
});
