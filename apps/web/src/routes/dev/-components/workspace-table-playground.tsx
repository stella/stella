/**
 * The workspace table's geometry, on a bench a test can measure.
 *
 * The shared table's hard parts are geometric: a header that freezes while the
 * body scrolls under it, pinned columns that freeze while the body scrolls past
 * them, and column widths that must be the same number in the header and in
 * every row. None of that can be asserted on a unit test, and on a real screen
 * it is behind a login and a search. So the results table is mounted here over
 * a fixed set of rows wide enough to scroll both ways — the same component the
 * public results page renders, not a lookalike, so a geometry test here is a
 * test of the product's table.
 *
 * The bench gives the table the chrome the results page gives it and nothing
 * more: a bounded column with a sibling above and below. Whether the table then
 * scrolls internally is the table's own doing, which is the point — a bench
 * that handed it a fixed height would answer the question under test.
 */

import { useState } from "react";

import { TEXT_FIELD_TYPE } from "@stll/api-contract/case-law-text-field";

import type { Decision } from "@/features/case-law/components/decision-cells";
import { DecisionTable } from "@/features/case-law/components/decision-table";
import { DEFAULT_DECISION_TABLE_LAYOUT } from "@/features/case-law/decision-column-preferences.logic";
import type { DecisionTableLayout } from "@/features/case-law/decision-column-preferences.logic";
import type { QuestionColumnSurface } from "@/features/case-law/research/question-columns.logic";

/** A bench has no organization, so it draws no question columns. */
const NO_QUESTION_COLUMNS: QuestionColumnSurface = { type: "hidden" };

/**
 * The bench shows every column and pins one past the checkbox, so a pinned
 * header cell sits at a non-zero inline offset — the case a single pinned
 * column at offset zero would not exercise.
 */
const BENCH_LAYOUT: DecisionTableLayout = {
  ...DEFAULT_DECISION_TABLE_LAYOUT,
  hidden: [],
  pinned: ["caseNumber"],
};

/**
 * The rows. Invented decisions of an unnamed court, written the way the corpus
 * writes them: a docket number, a date, a type, and a headnote long enough that
 * a row has to grow when the table stops clamping it.
 */
const BENCH_HEADNOTES = [
  "An appeal filed after the statutory period lapsed cannot be cured by the appellate court's own summons; the period runs from service, not from notice of the hearing.",
  "Where the contract nominates a single forum, a counterclaim arising from the same performance belongs before that forum even when its value exceeds the forum's ordinary ceiling.",
  "A creditor who accepts partial performance without reservation does not thereby waive the remainder, but bears the burden of showing the reservation was made.",
  "Reasons that merely restate the operative part do not satisfy the duty to give reasons, and the defect is not repaired by reasons supplied on appeal.",
  "The limitation period for a claim in unjust enrichment begins when the enriched party could first have been called upon to return the benefit.",
] as const;

const BENCH_TYPES = ["judgment", "resolution", "order"] as const;

/** A plain ISO date, which is one of the two shapes a decision date takes. */
const benchDate = (index: number): string => {
  const month = String(1 + (index % 12)).padStart(2, "0");
  const day = String(1 + (index % 27)).padStart(2, "0");
  return `2024-${month}-${day}`;
};

const benchDecisions = (): Decision[] =>
  Array.from({ length: 40 }, (_, index): Decision => {
    const senate = 21 + (index % 9);
    const sequence = 1400 + index * 7;
    return {
      id: `bench-${index}`,
      caseNumber: `${senate} Cdo ${sequence}/2024`,
      ecli: `ECLI:BENCH:2024:${senate}.CDO.${sequence}.1`,
      court: index % 3 === 0 ? "Supreme Court" : "Regional Court",
      courtAbbreviation: index % 3 === 0 ? "SC" : "RC",
      courtTier: index % 3 === 0 ? "supreme" : "regional",
      country: "CZ",
      language: "cs",
      languageAlternates: [],
      decisionDate: benchDate(index),
      decisionType: BENCH_TYPES[index % BENCH_TYPES.length] ?? "judgment",
      headline: BENCH_HEADNOTES[index % BENCH_HEADNOTES.length] ?? null,
      headnote: {
        type: TEXT_FIELD_TYPE.PRESENT,
        text: BENCH_HEADNOTES[(index + 2) % BENCH_HEADNOTES.length] ?? "",
        truncated: false,
      },
      citationCount: index % 17,
    } satisfies Decision;
  });

export const WorkspaceTablePlayground = () => {
  const [decisions] = useState(benchDecisions);
  const [layout, setLayout] = useState<DecisionTableLayout>(BENCH_LAYOUT);
  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
      data-playground-section="workspace-table"
    >
      <div className="flex shrink-0 items-center gap-2">
        <button
          className="rounded border px-2 py-1 text-xs"
          data-playground-content-mode="tight"
          onClick={() =>
            setLayout((current) => ({ ...current, contentMode: "tight" }))
          }
          type="button"
        >
          tight
        </button>
        <button
          className="rounded border px-2 py-1 text-xs"
          data-playground-content-mode="fit-content"
          onClick={() =>
            setLayout((current) => ({ ...current, contentMode: "fit-content" }))
          }
          type="button"
        >
          fit content
        </button>
      </div>
      <DecisionTable
        decisions={decisions}
        firstRowNumber={1}
        isLoading={false}
        layout={layout}
        onLayoutChange={setLayout}
        onSelectedIdsChange={setSelectedIds}
        questions={NO_QUESTION_COLUMNS}
        selectedIds={selectedIds}
      />
      {/* The results page keeps its pager below the table; the bench keeps a
          sibling of the same shape so the table has to claim the height it is
          given rather than take all of it. */}
      <div className="text-muted-foreground shrink-0 text-xs">
        bench rows, fixed
      </div>
    </section>
  );
};
