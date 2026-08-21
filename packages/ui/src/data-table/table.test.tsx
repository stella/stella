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
    expect(markup).toContain("Open Northwind</button>");
    expect(markup).toContain("caller-row");
    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain('tabindex="0"');
    expect(markup).toContain("Northwind");
  });

  test("renders one spanning empty or loading row", () => {
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
        columns={columns}
        emptyLabel="No matters"
        isLoading
        loadingLabel="Loading"
        rowKey={(row: { id: string }) => row.id}
        rows={[]}
      />,
    );

    expect(empty).toContain('colSpan="1"');
    expect(empty).toContain("No matters");
    expect(loading).toContain("Loading");
    expect(loading).not.toContain("No matters");
  });

  test("row selection ignores every nested interactive target", () => {
    const row = new EventTarget();
    const cell = new ClosestTarget("[role='presentation']");
    const interactiveSelectors = [
      "button",
      "label",
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
      expect(isDataTableRowActionTarget(row, new ClosestTarget(selector))).toBe(
        false,
      );
    }
  });
});

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
