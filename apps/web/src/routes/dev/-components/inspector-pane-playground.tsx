/**
 * The inspector pane's geometry, on a bench a test can measure.
 *
 * The pane is resizable down to 320px and nothing inside it may widen it: a
 * reader who drags it narrow gets a narrower column, never a document that
 * scrolls sideways under their hands. That invariant is pure layout — no unit
 * test reaches it, and on a real screen it is behind a login, a search and a
 * decision that happens to contain the right defect.
 *
 * So the bench mounts the product's own reader stack (`ScrollArea` with the
 * pane's axis, `reader-paper`, `DecisionText`) inside a box of exactly the
 * pane's minimum and default inline size, over a document written to break
 * it: a 320-character unbreakable token, the shape an embedded-object
 * identifier takes when it survives ingestion, and a twelve-column schedule
 * no narrow column can hold. Both are real defects seen in the corpus, not
 * invented stress cases.
 *
 * The pane is sized as the dock sizes it, rail included, so the reader under
 * measurement gets the width the product gives it and not one pixel more.
 *
 * What the bench does not hold: the signed-in docked composer, which needs an
 * authenticated context and a chat server. Its own widths are covered by the
 * fixes at their call sites, not here.
 */

import type { ComponentProps } from "react";

import { TEXT_FIELD_TYPE } from "@stll/api-contract/case-law-text-field";
import type { ReadDecisionTextFields } from "@stll/api-contract/case-law-text-field";
import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { DocumentAst } from "@stll/legal-ast/document-ast";
import {
  INSPECTOR_PANE_DEFAULT_WIDTH,
  INSPECTOR_PANE_MIN_WIDTH,
  INSPECTOR_RAIL_WIDTH,
} from "@stll/ui/inspector";
import { ScrollArea } from "@stll/ui/scroll-area";

import { ViewerOverlayBar } from "@/components/inspector/viewer-overlay-bar";
import { ZoomControls } from "@/components/inspector/zoom-controls";
import { DecisionText } from "@/features/case-law/components/case-viewer/decision-text";
import { CitationYearStrip } from "@/features/case-law/components/citation-year-strip";
import { toSafeId } from "@/lib/safe-id";

/**
 * The token. An embedded picture's identifier, as the Ústavní soud's RTF
 * conversion leaves it in the text: one word, no break opportunity, wider
 * than any pane. Long enough that no reader width can hold it.
 */
const UNBREAKABLE_TOKEN = `lipuid ${"133214628ed4f5188e833512a6fdbe5c".repeat(10)}`;

/**
 * The table, as a court's schedule of awarded compensation comes out of the
 * source file. Its width is column count, not long words: the reader canvas
 * breaks a word anywhere, so a cell has no minimum beyond one character plus
 * its padding, and only a table with more columns than the narrow pane has
 * room for still cannot fit. Twelve is what the wide schedules in the corpus
 * run to, and it is what makes the local scroll box the only way to read it.
 */
const BENCH_TABLE_HEADERS = [
  "Položka",
  "Rok",
  "Sazba",
  "Základ",
  "Koeficient",
  "Úrok",
  "Náklady",
  "Daň",
  "Celkem",
  "Měna",
  "Splatnost",
  "Poznámka",
] as const;

const BENCH_TABLE_ROW = [
  "Náhrada nemajetkové újmy",
  "2022",
  "14,25 %",
  "1 240 000",
  "1,35",
  "62 400",
  "18 150",
  "21 %",
  "1 341 700",
  "CZK",
  "30. 6. 2022",
  "§ 2958 odst. 1 písm. b)",
] as const;

const textCell = (text: string) => ({
  inlines: [{ type: "text" as const, text }],
  plainText: text,
});

const paragraph = (id: string, text: string) => ({
  id,
  anchorId: `p-${id}`,
  type: "paragraph" as const,
  inlines: [{ type: "text" as const, text }],
  plainText: text,
});

/**
 * The document: ordinary prose, the token, and a table too wide to wrap.
 *
 * Bound to `DocumentAst` rather than left as a free literal: the reader takes
 * it as `unknown` and falls back to "no text" for anything it cannot parse, so
 * a fixture one field short of the schema draws an empty pane and measures
 * nothing. The compiler is what keeps this shaped like what the API ships.
 */
const BENCH_DOCUMENT_AST = {
  version: 1,
  source: {
    system: "nalus",
    documentId: "bench-decision",
    webUrl: "https://nalus.usoud.cz/Search/GetText.aspx?id=bench",
    printUrl: "https://nalus.usoud.cz/Search/GetText.aspx?id=bench&print=1",
  },
  metadata: {
    caseNumber: "Pl. ÚS 20/21",
    ecli: "ECLI:CZ:US:2022:Pl.US.20.21.1",
    court: "Ústavní soud",
    decisionDate: "2022-05-17",
    decisionType: "nález",
    keywords: [],
    statutes: [],
  },
  blocks: [
    paragraph(
      "b1",
      "Ústavní soud rozhodl o návrhu na zrušení ustanovení zákona; odůvodnění se opírá o dosavadní judikaturu a o ustálený výklad dotčených ustanovení.",
    ),
    paragraph("b2", UNBREAKABLE_TOKEN),
    {
      id: "b3",
      anchorId: "p-b3",
      type: "table" as const,
      rows: [
        BENCH_TABLE_HEADERS.map((header) => ({
          ...textCell(header),
          header: true as const,
        })),
        BENCH_TABLE_ROW.map((cell) => textCell(cell)),
        BENCH_TABLE_ROW.map((cell) => textCell(cell)),
      ],
      plainText: [...BENCH_TABLE_HEADERS, ...BENCH_TABLE_ROW].join(" "),
    },
    paragraph(
      "b4",
      "Z uvedených důvodů Ústavní soud návrhu nevyhověl a řízení zastavil.",
    ),
  ],
} satisfies DocumentAst;

const ABSENT_TEXT_FIELD = {
  type: TEXT_FIELD_TYPE.ABSENT,
  reason: "not_published",
} as const;

const BENCH_TEXT_FIELDS = {
  abstract: ABSENT_TEXT_FIELD,
  headnote: ABSENT_TEXT_FIELD,
  legalSentence: ABSENT_TEXT_FIELD,
  summary: ABSENT_TEXT_FIELD,
} as const satisfies ReadDecisionTextFields;

const BENCH_DECISION = {
  caseNumber: "Pl. ÚS 20/21",
  caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
  court: "Ústavní soud",
  courtAbbreviation: null,
  courtTier: "other",
  documentAst: BENCH_DOCUMENT_AST,
  documentPending: false,
  documentReadFailed: false,
  documentUnavailable: false,
  fulltext: null,
  id: toSafeId<"caseLawDecision">("bench-decision"),
  judges: [],
  language: "cs",
  sourceAttributionUrl: null,
  textFields: BENCH_TEXT_FIELDS,
} satisfies ComponentProps<typeof DecisionText>["decision"];

/** Sixty years of citations: the strip at the widest span the API allows. */
const BENCH_CITATION_YEARS = Array.from({ length: 60 }, (_, index) => ({
  mixed: index % 11 === 0 ? 1 : 0,
  negative: index % 7 === 0 ? 1 : 0,
  neutral: index % 3 === 0 ? 2 : 0,
  positive: index % 5 === 0 ? 1 : 0,
  supportive: index % 2 === 0 ? 3 : 0,
  unclassified: 0,
  year: 1966 + index,
}));

/** The bench's controls drive nothing; the geometry is what it is for. */
const noop = () => undefined;

const BENCH_PANE_WIDTHS = [
  INSPECTOR_PANE_MIN_WIDTH,
  INSPECTOR_PANE_DEFAULT_WIDTH,
] as const;

/** One pane at one width, drawn as the inspector draws it. */
const BenchPane = ({ width }: { width: number }) => (
  <section
    className="bg-background flex h-[32rem] min-w-0 flex-row overflow-hidden border"
    data-playground-section="inspector-pane"
    data-pane-width={String(width)}
    style={{ width: `${String(width)}px` }}
  >
    {/* `InspectorDock` keeps the tab rail inside the pane's own width, so the
        active view gets the pane minus the rail: 272px at the 320px minimum,
        not 320px. The bench reserves it from the same constant the dock
        measures with, so the tested width cannot drift from production. The
        rail's own contents are tabs, which this geometry does not depend on. */}
    <div
      aria-hidden="true"
      className="bg-sidebar shrink-0 border-e"
      data-slot="inspector-rail"
      style={{ width: `${String(INSPECTOR_RAIL_WIDTH)}px` }}
    />
    <div className="relative min-h-0 min-w-0 flex-1">
      <ScrollArea axis="vertical" className="h-full">
        <main className="reader-paper min-h-full px-4 py-6">
          <div className="reader-chrome text-muted-foreground mb-3 flex text-xs">
            <CitationYearStrip
              byYear={BENCH_CITATION_YEARS}
              fromYear={1966}
              toYear={2025}
            />
          </div>
          <DecisionText
            activeMatchIndex={-1}
            decision={BENCH_DECISION}
            decisionId={BENCH_DECISION.id}
            searchQuery=""
          />
        </main>
      </ScrollArea>
      <ViewerOverlayBar>
        {/* The bar's geometry is what the bench measures; its controls have
            nothing to drive, so they stay at rest. */}
        <ZoomControls atMax atMin level={1} onReset={noop} onZoom={noop} />
      </ViewerOverlayBar>
    </div>
  </section>
);

export const InspectorPanePlayground = () => (
  <div className="flex flex-wrap items-start gap-6">
    {BENCH_PANE_WIDTHS.map((width) => (
      <BenchPane key={width} width={width} />
    ))}
  </div>
);
