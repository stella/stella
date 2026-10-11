import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, test } from "bun:test";
import { IntlProvider } from "use-intl";

import {
  TEXT_ABSENCE_REASON,
  TEXT_FIELD_TYPE,
} from "@stll/api-contract/case-law-text-field";
import { editorialSupplementBlocks } from "@stll/decision-reader/decision-text.logic";
import type { DecisionAnalysis } from "@stll/legal-ast/analysis";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type {
  DocumentAst,
  ParagraphBlock,
  ParagraphRole,
} from "@stll/legal-ast/document-ast";

import { WebDecisionReader as DecisionText } from "@/components/legal-reader/web-decision-reader";
import { WebReaderPresentationProvider } from "@/components/legal-reader/web-reader-presentation";
import { AiHeadnotes } from "@/features/case-law/components/case-viewer/analysis/ai-headnotes";
import { FormattingProvider } from "@/i18n/formatting-context";
import messages from "@/i18n/langs/en.json";
import { toSafeId } from "@/lib/safe-id";

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
} satisfies DocumentAst;

type TextDecision = ComponentProps<typeof DecisionText>["decision"];

const absent = {
  reason: TEXT_ABSENCE_REASON.NOT_PUBLISHED,
  type: TEXT_FIELD_TYPE.ABSENT,
} as const;

/** A decision as the read answers it, with no publisher text beside it. */
const textDecision = (overrides: Partial<TextDecision> = {}): TextDecision => ({
  caseNumber: "1 As 1/2026",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  country: "CZE",
  court: "Test court",
  courtAbbreviation: null,
  courtTier: "other",
  documentAst: ast,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  fulltext: null,
  id: toSafeId<"caseLawDecision">("9b1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
  judges: [],
  language: "cs",
  sourceAttributionUrl: null,
  textFields: {
    abstract: absent,
    headnote: absent,
    legalSentence: absent,
    summary: absent,
  },
  ...overrides,
});

const renderDecision = (abstract: string): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <DecisionText
            surface="development"
            decision={textDecision({
              sourceAttributionUrl: "https://rozhodnuti.nsoud.cz/detail/1",
              textFields: {
                abstract: { text: abstract, type: TEXT_FIELD_TYPE.PRESENT },
                headnote: absent,
                legalSentence: absent,
                summary: absent,
              },
            })}
            decisionId="dec-1"
          />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );

const renderStorageFulltext = async (
  expandProvisions: boolean,
): Promise<string> => {
  const fulltext = "Soud použil § 42 zákona.\n\nSoud odkázal na 2 As 2/2025.";
  const rootRoute = createRootRoute({
    component: () => (
      <DecisionText
        surface="development"
        decision={textDecision({ documentAst: null, fulltext })}
        decisionId="dec-1"
        expandProvisions={expandProvisions}
        isHydrated
        citationAnchors={[
          {
            id: "case-citation",
            citationText: "2 As 2/2025",
            treatment: "neutral",
            decision: {
              id: toSafeId<"caseLawDecision">(
                "2c1f0f3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
              ),
              caseNumber: "2 As 2/2025",
              caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
              country: "CZE",
              court: "Test court",
              courtAbbreviation: null,
              ecli: null,
              language: "cs",
              languageAlternates: [],
              slug: "2-as-2-2025",
              decisionDate: "2025-01-01",
              decisionType: "Judgment",
              sourceUrl: null,
            },
          },
        ]}
        provisionAnchors={[
          {
            id: "provision-citation",
            sentenceText: "Soud použil § 42 zákona.",
            spanStart: 12,
            reference: {
              unit: "section",
              section: 42,
              sectionSuffix: null,
              subsection: null,
              letter: null,
            },
            target: {
              document: {
                country: "CZE",
                eli: "/eli/cz/sb/2000/1",
                id: "01a02a37-1111-7111-8111-111111111111",
                slug: "1-2000-sb",
                versionValidFrom: "2000-01-01",
              },
              preview: null,
              payload: {
                documentId: "01a02a37-1111-7111-8111-111111111111",
                eli: "/eli/cz/sb/2000/1",
                jurisdiction: "CZE",
                anchorId: "par_42",
                provisionLabel: "§ 42",
                statuteTitle: "Test statute",
                versionValidFrom: "2000-01-01",
                versionCount: 1,
              },
            },
          },
        ]}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <FormattingProvider locale="en" timeZone="UTC">
            <QueryClientProvider client={new QueryClient()}>
              <RouterProvider router={router} />
            </QueryClientProvider>
          </FormattingProvider>
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );
};

test("storage-resolved fulltext retains stored provision and decision links without an AST", async () => {
  const markup = await renderStorageFulltext(false);
  expect(markup).toContain('data-anchor="fulltext:0"');
  expect(markup).toContain('data-anchor="fulltext:1"');
  expect(markup).toMatch(/<a[^>]*href="[^"]*par_42"/u);
  expect(markup).toMatch(/<a[^>]*href="[^"]*2-as-2-2025"/u);
  expect(markup).not.toContain('data-slot="provision-card"');
});

test("expanded provisions on storage-resolved fulltext draw under their paragraph", async () => {
  const markup = await renderStorageFulltext(true);
  const card = markup.indexOf('data-slot="provision-card"');
  expect(card).toBeGreaterThan(markup.indexOf('data-anchor="fulltext:0"'));
  expect(card).toBeLessThan(markup.indexOf('data-anchor="fulltext:1"'));
  expect(markup.slice(card)).toContain("§ 42");
});

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
        <FormattingProvider locale="en" timeZone="UTC">
          <WebReaderPresentationProvider>
            <QueryClientProvider client={new QueryClient()}>
              <DecisionText
                surface="development"
                decision={textDecision({
                  documentAst: null,
                  documentPending: true,
                  documentReadFailed: true,
                  textFields: {
                    abstract: {
                      text: "Analytická právní věta o náhradě škody.",
                      type: TEXT_FIELD_TYPE.PRESENT,
                    },
                    headnote: absent,
                    legalSentence: absent,
                    summary: absent,
                  },
                })}
                decisionId="dec-1"
              />
            </QueryClientProvider>
          </WebReaderPresentationProvider>
        </FormattingProvider>
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

// A landing passage keeps its marker after the reader arrives.
const landingAst = {
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
} satisfies DocumentAst;

const renderLandedDecision = ({
  landingAnchorId,
}: {
  landingAnchorId?: string | undefined;
}): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <DecisionText
            surface="development"
            decision={textDecision({ documentAst: landingAst, language: "en" })}
            decisionId="dec-1"
            landingAnchorId={landingAnchorId}
          />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );

const BODY_TEXT = "Court text.";

type TextFieldOverrides = Partial<
  Record<"abstract" | "legalSentence" | "summary", string>
>;

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
  courtAbbreviation = null,
  courtTier = "other",
  documentAst = ast,
  fields = {},
  notesByAnchorId,
}: Partial<
  Pick<TextDecision, "courtAbbreviation" | "courtTier" | "documentAst">
> & {
  analysis?: DecisionAnalysis;
  fields?: TextFieldOverrides;
  notesByAnchorId?: ReadonlyMap<string, ReactNode>;
} = {}): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <DecisionText
            surface="development"
            aiHeadnotes={
              analysis === undefined ? null : (
                <AiHeadnotes
                  analysis={analysis}
                  onAnchorClick={() => undefined}
                />
              )
            }
            decision={textDecision({
              courtAbbreviation,
              courtTier,
              documentAst,
              textFields: {
                abstract: presentOr(fields.abstract),
                headnote: absent,
                legalSentence: presentOr(fields.legalSentence),
                summary: presentOr(fields.summary),
              },
            })}
            decisionId="dec-1"
            notesByAnchorId={notesByAnchorId}
          />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );

describe("a decision opened at a passage", () => {
  test("the landing passage keeps a marker, and no other block takes one", () => {
    const markup = renderLandedDecision({
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

  test("renders a lifted headnote before the body", () => {
    const markup = renderTopMatter({
      documentAst: astWith([
        publisherParagraph("p-h", "headnotes", "Court reasoning, headnote."),
      ]),
    });
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

/** A court export stored one printed line per paragraph, wrapped near 68. */
const HARD_WRAPPED_LINES = [
  "Stěžovatel se ústavní stížností, která splňuje formální náležitosti",
  "stanovené zákonem č. 182/1993 Sb., o Ústavním soudu, domáhal zrušení",
  "v záhlaví uvedeného rozsudku, neboť podle jeho názoru jím obecné",
  "soudy porušily jeho základní právo na spravedlivý proces zaručené",
  "čl. 36 odst. 1 Listiny základních práv a svobod. Krajský soud podle",
  "stěžovatele nepřihlédl k důkazům, které navrhl, a své rozhodnutí",
  "řádně neodůvodnil, ačkoli tak byl povinen učinit podle ustanovení",
  "§ 157 odst. 2 občanského soudního řádu.",
  "Ústavní soud si vyžádal spis a vyjádření účastníků řízení. Krajský",
  "soud ve svém vyjádření uvedl, že poměry stěžovatele posoudil podle",
  "ustálené judikatury a v souladu se zákonem.",
];

const lineParagraph = (line: string, index: number): ParagraphBlock => ({
  anchorId: `p-${String(index)}`,
  id: `b${String(index)}`,
  inlines: [{ text: line, type: "text" }],
  plainText: line,
  type: "paragraph",
});

const renderWrappedDecision = (lines: readonly string[]): string =>
  renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <WebReaderPresentationProvider>
          <DecisionText
            decision={textDecision({
              documentAst: { ...ast, blocks: lines.map(lineParagraph) },
            })}
            surface="development"
            decisionId="dec-1"
            landingAnchorId="p-3"
          />
        </WebReaderPresentationProvider>
      </FormattingProvider>
    </IntlProvider>,
  );

describe("a decision stored as hard-wrapped lines", () => {
  test("draws each wrapped paragraph once, with every line still anchored", () => {
    const markup = renderWrappedDecision(HARD_WRAPPED_LINES);

    // The reference line, then the two paragraphs the lines were printed as.
    expect(occurrences(markup, "<p ")).toBe(3);
    for (const index of HARD_WRAPPED_LINES.keys()) {
      expect(markup).toContain(
        `data-anchor="p-${String(index)}" id="p-${String(index)}"`,
      );
    }
    // One landing marker, on the paragraph holding the landing line.
    expect(occurrences(markup, "data-reader-landing")).toBe(1);
  });

  test("draws an unwrapped decision one paragraph per block", () => {
    const lines = HARD_WRAPPED_LINES.map((line) => `${line.slice(0, 20)}.`);
    const markup = renderWrappedDecision(lines);

    expect(occurrences(markup, "<p ")).toBe(lines.length + 1);
    for (const index of lines.keys()) {
      expect(markup).toContain(`data-anchor="p-${String(index)}"`);
    }
  });
});

const headingBlock = (
  text: string,
  index: number,
): DocumentAst["blocks"][number] => ({
  anchorId: `p-${String(index)}`,
  id: `b${String(index)}`,
  inlines: [{ text, type: "text" }],
  level: 2,
  plainText: text,
  type: "heading",
});

/** Markup with every undrawn span and then every tag taken out. */
const drawnMarkup = (markup: string): string =>
  markup
    .replaceAll(/<span class="hidden"[^>]*>[^<]*<\/span>/gu, "")
    .replaceAll(/<[^>]+>/gu, "");

describe("a letter-spaced heading", () => {
  const SPACED = "O d ů v o d n ě n í :";
  const render = (): string =>
    renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <WebReaderPresentationProvider>
            <DecisionText
              decision={textDecision({
                documentAst: {
                  ...ast,
                  blocks: [
                    headingBlock(SPACED, 1),
                    lineParagraph("Žalobce se domáhal určení.", 2),
                  ],
                },
              })}
              surface="development"
              decisionId="dec-1"
            />
          </WebReaderPresentationProvider>
        </FormattingProvider>
      </IntlProvider>,
    );

  test("draws the word while every source character stays in its anchor", () => {
    const markup = render();
    const heading = markup.slice(
      markup.indexOf('data-anchor="p-1"'),
      markup.indexOf("</h2>"),
    );

    // Ten spaces, each kept in the text but not drawn.
    expect(occurrences(heading, 'data-reader-elided="letter-spacing"')).toBe(
      10,
    );
    expect(drawnMarkup(heading)).toContain("Odůvodnění:");
    // Every source character is still in the anchored element, in order.
    expect(heading.replaceAll(/<[^>]+>/gu, "")).toContain(SPACED);
  });
});

describe("quotation marks the publisher printed escaped", () => {
  // As rozhodnuti.nsoud.cz serves part of its older decisions: `\&quot;`.
  const ESCAPED = 'Žalobce tvrdil, že \\"smlouva o půjčce\\" je neplatná.';

  test("are drawn without the backslash, which stays in the anchored text", () => {
    const markup = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <WebReaderPresentationProvider>
            <DecisionText
              decision={textDecision({
                documentAst: { ...ast, blocks: [lineParagraph(ESCAPED, 1)] },
              })}
              surface="development"
              decisionId="dec-1"
            />
          </WebReaderPresentationProvider>
        </FormattingProvider>
      </IntlProvider>,
    );
    const paragraph = markup.slice(markup.indexOf('data-anchor="p-1"'));

    expect(occurrences(paragraph, 'data-reader-elided="escaped-quote"')).toBe(
      2,
    );
    expect(drawnMarkup(paragraph)).toContain(
      "že &quot;smlouva o půjčce&quot; je neplatná.",
    );
    expect(paragraph.replaceAll(/<[^>]+>/gu, "")).toContain(
      "že \\&quot;smlouva o půjčce\\&quot; je neplatná.",
    );
  });
});

/**
 * The opening of an older Supreme Court judgment as the parser stores it:
 * the court's first line alone, then the rest of the caption run together
 * in one paragraph. Shaped like 21 Cdo 1484/2004; constructed for this test.
 */
const RUN_ON_CAPTION_PIECES = [
  "\n",
  "ČESKÉ REPUBLIKY\t              21 Cdo 1484/2004",
  " ",
  "\n",
  "ČESKÁ REPUBLIKA ",
  " ",
  "\n",
  "ROZSUDEK",
  " ",
  "\n",
  "JMÉNEM REPUBLIKY",
];

const runOnCaptionAst = {
  ...ast,
  blocks: [
    lineParagraph("NEJVYŠŠÍ SOUD", 1),
    {
      anchorId: "p-2",
      id: "b2",
      inlines: RUN_ON_CAPTION_PIECES.map((text) => ({ text, type: "text" })),
      plainText:
        "ČESKÉ REPUBLIKY\t 21 Cdo 1484/2004 ČESKÁ REPUBLIKA ROZSUDEK JMÉNEM REPUBLIKY",
      type: "paragraph",
    },
    lineParagraph("Nejvyšší soud České republiky rozhodl takto:", 3),
  ],
} satisfies DocumentAst;

describe("a caption stored run on", () => {
  const render = (country: string): string =>
    renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <WebReaderPresentationProvider>
            <DecisionText
              decision={textDecision({ country, documentAst: runOnCaptionAst })}
              surface="development"
              decisionId="dec-1"
            />
          </WebReaderPresentationProvider>
        </FormattingProvider>
      </IntlProvider>,
    );

  /** The element anchored as `anchorId`, from its opening tag on. */
  const anchored = (markup: string, anchorId: string): string =>
    markup.slice(markup.indexOf(`data-anchor="${anchorId}"`));

  test("is drawn as the court's header, one printed line at a time", () => {
    const markup = render("CZE");
    const header = markup.slice(
      markup.indexOf("<header>"),
      markup.indexOf("</header>"),
    );

    expect(header).toMatch(/<h1 [^>]*>ROZSUDEK<\/h1>/u);
    for (const line of [
      "NEJVYŠŠÍ SOUD",
      "ČESKÉ REPUBLIKY",
      "21 Cdo 1484/2004",
      "ČESKÁ REPUBLIKA",
      "JMÉNEM REPUBLIKY",
    ]) {
      expect(header).toMatch(new RegExp(`<p [^>]*>${line}</p>`, "u"));
    }
    // The body sentence naming the court stays body text.
    expect(header).not.toContain("rozhodl");
  });

  test("keeps every block anchored, holding exactly its stored text", () => {
    const markup = render("CZE");
    for (const anchorId of ["p-1", "p-2", "p-3"]) {
      expect(markup).toContain(`data-anchor="${anchorId}" `);
    }
    const block = anchored(markup, "p-2");
    const words = block
      .slice(block.indexOf(">") + 1, block.indexOf("</div>"))
      .replaceAll(/<a [^>]*data-reader-chrome[^>]*>¶<\/a>/gu, "")
      .replaceAll(/<[^>]+>/gu, "");
    expect(words).toBe(RUN_ON_CAPTION_PIECES.join(""));
  });

  test("is drawn as stored where the jurisdiction prints no such caption", () => {
    const markup = render("AUT");
    expect(markup).not.toContain("<header>");
    expect(markup).toContain("ČESKÉ REPUBLIKY\t              21 Cdo 1484/2004");
  });
});
