import { describe, expect, test } from "bun:test";

import type { TableSchema } from "./schema";
import {
  duplicateColumnIds,
  findTableColumn,
  hideableColumnIds,
  sortableColumnIds,
  tableColumnIds,
  tableColumnSizing,
  visibleColumnIds,
} from "./schema";

type Render = { type: string };

const column = (
  id: string,
  {
    sort = true,
    hide = true,
    size = 100,
  }: { sort?: boolean; hide?: boolean; size?: number } = {},
) => ({
  id,
  label: id,
  render: { type: id },
  size,
  capabilities: { sort, hide, resize: true, pin: true },
  emphasis: "content" as const,
});

const schema = (
  ...columns: ReturnType<typeof column>[]
): TableSchema<Render> => ({ columns, defaultMinSize: 64 });

describe("capability queries", () => {
  const example = schema(
    column("select", { sort: false, hide: false, size: 48 }),
    column("name"),
    column("author", { sort: false }),
  );

  test("column ids come back in the schema's order", () => {
    expect(tableColumnIds(example)).toEqual(["select", "name", "author"]);
  });

  test("only sortable columns are sortable", () => {
    expect(sortableColumnIds(example)).toEqual(["name"]);
  });

  test("only hideable columns are hideable", () => {
    expect(hideableColumnIds(example)).toEqual(["name", "author"]);
  });

  test("a column is found by id, and only by its own", () => {
    expect(findTableColumn(example, "name")?.label).toBe("name");
    expect(findTableColumn(example, "missing")).toBeUndefined();
  });

  test("sizing is keyed by column id", () => {
    expect(tableColumnSizing(example)).toEqual({
      select: 48,
      name: 100,
      author: 100,
    });
  });
});

describe("visibility", () => {
  test("a column that cannot be hidden stays visible whatever is stored", () => {
    const example = schema(column("select", { hide: false }), column("name"));

    expect(visibleColumnIds(example, ["select", "name"])).toEqual(["select"]);
  });

  test("hiding nothing shows every column", () => {
    const example = schema(column("a"), column("b"), column("c"));

    expect(visibleColumnIds(example, [])).toEqual(tableColumnIds(example));
  });

  test("hiding is idempotent", () => {
    const example = schema(column("a"), column("b"));

    expect(visibleColumnIds(example, ["a"])).toEqual(
      visibleColumnIds(example, ["a"]),
    );
  });
});

describe("duplicate ids", () => {
  test("a repeated id is reported once", () => {
    expect(
      duplicateColumnIds(schema(column("a"), column("a"), column("a"))),
    ).toEqual(["a"]);
  });

  test("a schema with distinct ids reports none", () => {
    expect(duplicateColumnIds(schema(column("a"), column("b")))).toEqual([]);
  });
});
