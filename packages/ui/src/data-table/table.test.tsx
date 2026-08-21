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
    expect(markup).toContain('<button class="sr-only" type="button">');
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
    const cell = new ClosestTarget(null);
    const nestedControl = new ClosestTarget({});

    expect(isDataTableRowActionTarget(row, row)).toBe(true);
    expect(isDataTableRowActionTarget(row, cell)).toBe(true);
    expect(isDataTableRowActionTarget(row, nestedControl)).toBe(false);
    expect(nestedControl.seenSelector).toContain("button");
    expect(nestedControl.seenSelector).toContain(
      "[data-data-table-stop-row-action]",
    );
  });
});

class ClosestTarget extends EventTarget {
  private readonly match: unknown;

  seenSelector = "";

  constructor(match: unknown) {
    super();
    this.match = match;
  }

  closest(selector: string) {
    this.seenSelector = selector;
    return this.match;
  }
}
