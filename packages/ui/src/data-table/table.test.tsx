import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";

import { DataTable } from "./table";

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
        getRowProps={() => ({
          "aria-label": "Caller label",
          className: "caller-row",
          role: "row",
          tabIndex: -1,
        })}
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
    expect(markup).toContain('aria-label="Open Northwind"');
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain("caller-row");
    expect(markup).not.toContain("Caller label");
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
});
