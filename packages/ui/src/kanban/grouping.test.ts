import { describe, expect, test } from "bun:test";

import type { KanbanGroupOption, KanbanSchema } from "./grouping";
import {
  getKanbanGroupingPropertyId,
  getKanbanGroups,
  isKanbanGroupingRenderable,
  resolveKanbanGroupOptions,
  resolveKanbanGrouping,
  selectKanbanRows,
} from "./grouping";

type Row = { id: string; kind: string };
type Property = { id: string; groupable: boolean };

const option = (value: string): KanbanGroupOption => ({ value, label: value });

const schema = ({
  builtInIds = [],
  properties = [],
  scoped = null,
}: {
  builtInIds?: readonly string[];
  properties?: readonly Property[];
  scoped?: string | null;
} = {}): KanbanSchema<Row, Property> => ({
  builtInGroups: builtInIds.map((id) => ({
    id,
    options: id === "_empty" ? [] : [option(`${id}-a`), option(`${id}-b`)],
    ...(id === scoped
      ? {
          selectRows: (rows: readonly Row[]) =>
            rows.filter((r) => r.kind === "task"),
        }
      : {}),
  })),
  properties,
  getPropertyId: (property) => property.id,
  getPropertyOptions: (property) =>
    property.groupable ? [option("one"), option("two")] : null,
});

describe("resolveKanbanGrouping", () => {
  test("the group-by id round-trips when it names something the schema has", () => {
    const example = schema({
      builtInIds: ["_status"],
      properties: [{ id: "phase", groupable: true }],
    });

    expect(
      getKanbanGroupingPropertyId(
        resolveKanbanGrouping({ groupBy: "phase", schema: example }),
      ),
    ).toBe("phase");
    expect(
      getKanbanGroupingPropertyId(
        resolveKanbanGrouping({ groupBy: "_nope", schema: example }),
      ),
    ).toBeNull();
  });

  test("an empty group-by is no grouping", () => {
    expect(resolveKanbanGrouping({ groupBy: "", schema: schema() })).toEqual({
      type: "none",
    });
  });

  test("a reserved id resolves to its built-in group", () => {
    const grouping = resolveKanbanGrouping({
      groupBy: "_status",
      schema: schema({ builtInIds: ["_status", "_kind"] }),
    });

    expect(grouping.type).toBe("built-in");
    expect(resolveKanbanGroupOptions(grouping).map((o) => o.value)).toEqual([
      "_status-a",
      "_status-b",
    ]);
  });

  test("an unknown id is no grouping", () => {
    expect(
      resolveKanbanGrouping({
        groupBy: "_nothing",
        schema: schema({ builtInIds: ["_status"] }),
      }),
    ).toEqual({ type: "none" });
  });

  test("a property that cannot carry columns still resolves, with none", () => {
    const grouping = resolveKanbanGrouping({
      groupBy: "notes",
      schema: schema({ properties: [{ id: "notes", groupable: false }] }),
    });

    expect(grouping.type).toBe("property");
    expect(resolveKanbanGroupOptions(grouping)).toEqual([]);
  });
});

describe("isKanbanGroupingRenderable", () => {
  test("a built-in group that declares no columns is not a board", () => {
    expect(
      isKanbanGroupingRenderable(
        resolveKanbanGrouping({
          groupBy: "_empty",
          schema: schema({ builtInIds: ["_empty"] }),
        }),
      ),
    ).toBe(false);
  });

  test("a property with no options still draws its uncategorized column", () => {
    expect(
      isKanbanGroupingRenderable(
        resolveKanbanGrouping({
          groupBy: "notes",
          schema: schema({ properties: [{ id: "notes", groupable: false }] }),
        }),
      ),
    ).toBe(true);
  });
});

describe("selectKanbanRows", () => {
  const rows: Row[] = [
    { id: "a", kind: "document" },
    { id: "b", kind: "task" },
    { id: "c", kind: "folder" },
  ];

  test("a built-in group without a scope keeps every row", () => {
    const grouping = resolveKanbanGrouping({
      groupBy: "_kind",
      schema: schema({ builtInIds: ["_kind"] }),
    });

    expect(selectKanbanRows(rows, grouping).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("a built-in group's scope narrows the board", () => {
    const grouping = resolveKanbanGrouping({
      groupBy: "_status",
      schema: schema({ builtInIds: ["_status"], scoped: "_status" }),
    });

    expect(selectKanbanRows(rows, grouping).map((r) => r.id)).toEqual(["b"]);
  });

  test("a property grouping keeps every row", () => {
    const grouping = resolveKanbanGrouping({
      groupBy: "phase",
      schema: schema({ properties: [{ id: "phase", groupable: true }] }),
    });

    expect(selectKanbanRows(rows, grouping).map((r) => r.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

describe("getKanbanGroups", () => {
  test("the uncategorized bucket comes last, exactly once, after every option", () => {
    const groups = getKanbanGroups([option("draft"), option("review")], "None");

    expect(groups.map((group) => group.value)).toEqual([
      "draft",
      "review",
      null,
    ]);
    expect(groups.at(-1)?.label).toBe("None");
  });

  test("a board with no options is still a board: the bucket alone", () => {
    expect(getKanbanGroups([], "None").map((group) => group.value)).toEqual([
      null,
    ]);
  });

  test("preserves identity images on rendered groups", () => {
    const groups = getKanbanGroups(
      [
        {
          value: "user-1",
          label: "Anna Nováková",
          image: "https://example.test/anna.jpg",
        },
      ],
      "None",
    );

    expect(groups.at(0)?.image).toBe("https://example.test/anna.jpg");
    expect(groups.at(-1)?.image).toBeUndefined();
  });
});
