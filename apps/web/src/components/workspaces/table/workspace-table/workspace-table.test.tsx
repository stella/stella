/**
 * What the shared table body paints before anything has been measured.
 *
 * A static render is that state exactly: no scroll element, so the virtualizer
 * has no window and no row measurement. It is also what the browser hits when
 * the scroll container's height arrives only with a later layout pass — the
 * table then painted its fillers and none of its rows.
 */

import { renderToStaticMarkup } from "react-dom/server";

import { useTable } from "@tanstack/react-table";
import { describe, expect, test } from "bun:test";

import type { TableRowHost } from "@/components/workspaces/table/row-host";
import { workspaceTableFeatures } from "@/components/workspaces/table/table-features";
import type { DecisionRowData } from "@/components/workspaces/table/types";
import { UNMEASURED_WINDOW_ROW_COUNT } from "@/components/workspaces/table/workspace-table/row-window.logic";
import { WorkspaceTable } from "@/components/workspaces/table/workspace-table/workspace-table";

/** What the harness's row host prints, so a painted row names its index. */
const rowMarker = (index: number) => `row ${index}`;

const decisionRows = (count: number): DecisionRowData[] =>
  Array.from({ length: count }, (_unused, index) => ({
    kind: "decision" as const,
    children: [] as [],
    decision: {
      id: `decision-${index}`,
      caseNumber: `case ${index}`,
      ecli: null,
      court: "Nejvyšší soud",
      country: "cze",
      language: "cs",
      languageAlternates: [],
      slug: null,
      decisionDate: null,
      decisionType: null,
      headnote: { type: "absent", reason: "not_published" } as const,
      citationCount: 0,
    },
  }));

const rowHost: TableRowHost<DecisionRowData> = {
  renderRow: ({ row, index }) => (
    <div data-index={index} role="row">
      {rowMarker(row.index)}
    </div>
  ),
};

const Harness = ({
  rowCount,
  skeletonRowCount = 0,
}: {
  rowCount: number;
  skeletonRowCount?: number;
}) => {
  const table = useTable({
    features: workspaceTableFeatures,
    data: decisionRows(rowCount),
    columns: [
      {
        id: "caseNumber",
        header: "Case",
        accessorFn: (row: DecisionRowData) => row.decision.caseNumber,
      },
    ],
    getRowId: (row) => row.decision.id,
  });

  return (
    <WorkspaceTable
      contentMode="tight"
      rowHost={rowHost}
      skeletonRowCount={skeletonRowCount}
      table={table}
    />
  );
};

const paintedRowCount = (markup: string, rowCount: number) =>
  Array.from({ length: rowCount }, (_unused, index) => index).filter((index) =>
    markup.includes(`>${rowMarker(index)}<`),
  ).length;

describe("the table body before it is measured", () => {
  test("paints the rows it has rather than filler alone", () => {
    const rowCount = 50;
    const markup = renderToStaticMarkup(<Harness rowCount={rowCount} />);

    expect(markup).toContain(`aria-rowcount="${rowCount}"`);
    expect(paintedRowCount(markup, rowCount)).toBe(UNMEASURED_WINDOW_ROW_COUNT);
    // They are the first rows, and they stop at the bound the module names.
    expect(markup).toContain(`>${rowMarker(0)}<`);
    expect(markup).not.toContain(`>${rowMarker(UNMEASURED_WINDOW_ROW_COUNT)}<`);
  });

  test("paints every row of a set smaller than the unmeasured window", () => {
    const rowCount = 3;
    const markup = renderToStaticMarkup(<Harness rowCount={rowCount} />);

    expect(paintedRowCount(markup, rowCount)).toBe(rowCount);
  });

  test("stands rows in for a table still loading its own", () => {
    const markup = renderToStaticMarkup(
      <Harness rowCount={0} skeletonRowCount={5} />,
    );

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-slot="skeleton"');
  });

  test("draws no row and no placeholder for a table with none", () => {
    const markup = renderToStaticMarkup(<Harness rowCount={0} />);

    expect(markup).toContain('aria-rowcount="0"');
    expect(markup).not.toContain("data-index=");
    expect(markup).not.toContain('data-slot="skeleton"');
  });
});
