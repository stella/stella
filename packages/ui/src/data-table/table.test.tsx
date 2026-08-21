import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { DataTable, isDataTableRowActionTarget } from "./table";

const columns = [
  {
    ariaSort: "ascending",
    header: "Matter",
    id: "name",
    render: (row: { id: string; name: string }) => row.name,
  },
] as const;

describe("DataTable", () => {
  test("renders entity-agnostic columns and accessible row actions", () => {
    const markup = renderToStaticMarkup(
      <DataTable
        columns={columns}
        emptyLabel="No matters"
        getRowProps={() => ({ className: "caller-row" })}
        loadingLabel="Loading"
        rowAction={{
          getAriaLabel: (row) => `Open ${row.name}`,
          onSelect: () => undefined,
        }}
        rowKey={(row) => row.id}
        rows={[{ id: "matter-1", name: "Northwind" }]}
      />,
    );

    expect(markup).toContain('aria-sort="ascending"');
    expect(markup).toContain("focus-visible:not-sr-only");
    expect(markup).toContain("focus-visible:ring-2");
    expect(markup).toContain('data-slot="button"');
    expect(markup).toContain("Open Northwind</button>");
    expect(markup).toContain("caller-row");
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('tabindex="0"');
    expect(markup).toContain("Northwind");
  });

  test("renders a spanning empty row and column-aligned loading skeletons", () => {
    const empty = renderToStaticMarkup(
      <DataTable
        columns={columns}
        emptyLabel="No matters"
        loadingLabel="Loading"
        rowKey={(row: { id: string }) => row.id}
        rows={[]}
      />,
    );
    const loading = renderToStaticMarkup(
      <DataTable
        columns={[
          ...columns,
          {
            header: "Status",
            id: "status",
            render: () => "Open",
          },
        ]}
        emptyLabel="No matters"
        isLoading
        loadingLabel="Loading"
        loadingRowCount={2}
        rowKey={(row: { id: string }) => row.id}
        rows={[]}
      />,
    );

    expect(empty).toContain('colSpan="1"');
    expect(empty).toContain("No matters");
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Loading");
    expect(loading.match(/data-slot="skeleton"/gu)).toHaveLength(4);
    expect(loading).not.toContain("colSpan");
    expect(loading).not.toContain("No matters");
  });

  test("keeps at least one loading row after rounding", () => {
    const loading = renderToStaticMarkup(
      <DataTable
        columns={columns}
        emptyLabel="No matters"
        isLoading
        loadingLabel="Loading"
        loadingRowCount={0.5}
        rowKey={(row: { id: string }) => row.id}
        rows={[]}
      />,
    );

    expect(loading.match(/data-slot="skeleton"/gu)).toHaveLength(1);
    expect(loading).toContain("Loading");
  });

  test("row selection ignores every nested interactive target", () => {
    const cell = new ClosestTarget("[role='presentation']");
    const row = new ContainmentTarget([cell]);
    const interactiveSelectors = [
      "button",
      "label",
      "[contenteditable]:not([contenteditable='false'])",
      "[role='checkbox']",
      "[role='combobox']",
      "[role='menuitem']",
      "[role='radio']",
      "[role='switch']",
      "[role='tab']",
      "[data-data-table-stop-row-action]",
    ];

    expect(isDataTableRowActionTarget(row, row)).toBe(true);
    expect(isDataTableRowActionTarget(row, cell)).toBe(true);
    for (const selector of interactiveSelectors) {
      const target = new ClosestTarget(selector);
      row.add(target);
      expect(isDataTableRowActionTarget(row, target)).toBe(false);
    }
  });

  test("row selection ignores React-bubbled targets outside the row", () => {
    const row = new ContainmentTarget([]);
    const portaledPopup = new ClosestTarget("[role='presentation']");

    expect(isDataTableRowActionTarget(row, portaledPopup)).toBe(false);
  });
});

class ContainmentTarget extends EventTarget {
  private readonly targets: Set<EventTarget>;

  constructor(targets: readonly EventTarget[]) {
    super();
    this.targets = new Set(targets);
  }

  add(target: EventTarget) {
    this.targets.add(target);
  }

  contains(target: EventTarget | null) {
    return target !== null && this.targets.has(target);
  }
}

class ClosestTarget extends EventTarget {
  private readonly matchingSelector: string;

  seenSelector = "";

  constructor(matchingSelector: string) {
    super();
    this.matchingSelector = matchingSelector;
  }

  closest(selector: string) {
    this.seenSelector = selector;
    return selector.includes(this.matchingSelector) ? {} : null;
  }
}
