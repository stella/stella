/**
 * A table mounts without reading layout once per row.
 *
 * A layout read (`getBoundingClientRect`, `offsetHeight`, ...) made while
 * React commits makes the browser recalculate style and lay the page out
 * right then, before the next row is attached; a read per row does that once
 * per row, and every view switch to a table waited on it. Rows are measured
 * from the virtualizer's ResizeObserver entries, delivered after layout.
 *
 * The property: the reads a mount makes do not depend on how many rows it
 * draws. A test DOM lays nothing out, so the count is exact and the
 * comparison is between mounts of one row and of a full unmeasured window.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { TableRowHost } from "@/components/workspaces/table/row-host";
import type { DecisionRowData } from "@/components/workspaces/table/types";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
// The app's stylesheet makes the table's scroll element scroll; without it the
// drag auto-scroller warns that it was attached to one that does not.
const scrollStyle = document.createElement("style");
scrollStyle.textContent =
  '[data-slot="workspace-table-scroll"] { overflow-x: auto; overflow-y: auto; }';
document.head.append(scrollStyle);

const { cleanup, render } = await import("@testing-library/react");
const { useTable } = await import("@tanstack/react-table");
const { workspaceTableFeatures } =
  await import("@/components/workspaces/table/table-features");
const { UNMEASURED_WINDOW_ROW_COUNT } =
  await import("@/components/workspaces/table/workspace-table/row-window.logic");
const { WorkspaceTable } =
  await import("@/components/workspaces/table/workspace-table/workspace-table");

afterEach(cleanup);
afterAll(async () => {
  cleanup();
  await unregisterDomEnvironment();
});

const decisionRows = (count: number): DecisionRowData[] =>
  Array.from({ length: count }, (_unused, index) => ({
    kind: "decision" as const,
    children: [] as [],
    decision: {
      id: `decision-${index}`,
      caseNumber: `case ${index}`,
      caseNumberType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      ecli: null,
      court: "Nejvyšší soud",
      country: "cze",
      language: "cs",
      languageAlternates: [],
      slug: null,
      decisionDate: null,
      decisionType: null,
      decisionTypeKind: null,
      headnote: { type: "absent", reason: "not_published" } as const,
      citationCount: 0,
    },
  }));

// Rows attach to the virtualizer the way entity rows do: the row element is
// handed to `measureElement` as React attaches it.
const rowHost: TableRowHost<DecisionRowData> = {
  renderRow: ({ index, measureElement }) => (
    <div data-index={index} ref={measureElement} role="row" />
  ),
};

const Harness = ({ rowCount }: { rowCount: number }) => {
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
  return <WorkspaceTable contentMode="tight" rowHost={rowHost} table={table} />;
};

type LayoutReadCounter = { reads: number };

/** Counts reads of one layout getter, returning the restore. */
const countGetter = (
  counter: LayoutReadCounter,
  owner: object,
  name: string,
) => {
  const descriptor = Object.getOwnPropertyDescriptor(owner, name);
  const get = descriptor?.get;
  if (descriptor === undefined || get === undefined) {
    return () => undefined;
  }
  Object.defineProperty(owner, name, {
    ...descriptor,
    get() {
      counter.reads += 1;
      return get.call(this);
    },
  });
  return () => Object.defineProperty(owner, name, descriptor);
};

/** Counts the layout reads made while `run` executes. */
const countLayoutReads = (run: () => void) => {
  const counter: LayoutReadCounter = { reads: 0 };
  const elementRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    counter.reads += 1;
    return elementRect.call(this);
  };
  const computedStyle = window.getComputedStyle;
  window.getComputedStyle = (element, pseudo) => {
    counter.reads += 1;
    return computedStyle.call(window, element, pseudo);
  };
  const restores = [
    countGetter(counter, HTMLElement.prototype, "offsetHeight"),
    countGetter(counter, HTMLElement.prototype, "offsetWidth"),
    countGetter(counter, HTMLElement.prototype, "offsetTop"),
    countGetter(counter, Element.prototype, "clientHeight"),
    countGetter(counter, Element.prototype, "clientWidth"),
    countGetter(counter, Element.prototype, "scrollHeight"),
    countGetter(counter, Element.prototype, "scrollWidth"),
  ];
  try {
    run();
  } finally {
    for (const restore of restores) {
      restore();
    }
    window.getComputedStyle = computedStyle;
    Element.prototype.getBoundingClientRect = elementRect;
  }
  return counter.reads;
};

const mountReads = (rowCount: number) => {
  const reads = countLayoutReads(() => {
    const view = render(<Harness rowCount={rowCount} />);
    expect(
      view.container.querySelectorAll('[role="row"][data-index]'),
    ).toHaveLength(Math.min(rowCount, UNMEASURED_WINDOW_ROW_COUNT));
  });
  cleanup();
  return reads;
};

test("mounting more rows makes no more layout reads", () => {
  const one = mountReads(1);
  const full = mountReads(UNMEASURED_WINDOW_ROW_COUNT);

  expect(full).toBe(one);
});
