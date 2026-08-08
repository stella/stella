import { describe, expect, test } from "bun:test";

import { getDefaultViews, normalizeDefaultViewLayout } from "@/api/lib/views";
import type { ViewLayout } from "@/api/lib/views-schema";
import { convertLayout } from "@/api/lib/views/utils";

describe("getDefaultViews", () => {
  test("pins requested file columns in the default table view", () => {
    const views = getDefaultViews("en", {
      tableColumnPinning: ["property-file"],
    });

    const tableView = views.find((view) => view.layout.type === "table");

    expect(tableView?.layout).toMatchObject({
      type: "table",
      columnPinning: ["property-file"],
    });
  });

  test("returns cloned table pinning arrays", () => {
    const pinned = ["property-file"];
    const views = getDefaultViews("en", { tableColumnPinning: pinned });
    pinned.push("property-status");

    const tableView = views.find((view) => view.layout.type === "table");

    expect(tableView?.layout).toMatchObject({
      type: "table",
      columnPinning: ["property-file"],
    });
  });

  test("seeds Lists as a task-scoped saved view", () => {
    const views = getDefaultViews("en", { legalListsEnabled: true });
    const listView = views.find((view) => view.name === "Lists");

    expect(listView?.layout).toMatchObject({
      type: "kanban",
      groupByPropertyId: "_status",
      filters: [
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["task"],
        },
      ],
    });
  });

  test("upgrades a legacy default Todos view without changing custom views", () => {
    const legacyLayout = {
      version: 1,
      type: "kanban",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      groupByPropertyId: "_status",
    } satisfies Extract<ViewLayout, { type: "kanban" }>;

    expect(
      normalizeDefaultViewLayout({
        layout: legacyLayout,
        name: "Todos",
      }),
    ).toMatchObject({ filters: [{ operand: { type: "kind" } }] });
    expect(
      normalizeDefaultViewLayout({
        layout: legacyLayout,
        name: "My board",
      }),
    ).toBe(legacyLayout);
  });

  test("keeps legacy Todos task-scoped when converting to a table", () => {
    const legacyLayout = {
      version: 1,
      type: "kanban",
      filters: [],
      sorts: [],
      hiddenProperties: [],
      groupByPropertyId: "_status",
    } satisfies Extract<ViewLayout, { type: "kanban" }>;

    const normalized = normalizeDefaultViewLayout({
      layout: legacyLayout,
      name: "Todos",
    });
    const converted = convertLayout(normalized, "table");

    expect(converted.filters).toEqual([
      {
        type: "predicate",
        operand: { type: "kind" },
        op: "in",
        value: ["task"],
      },
    ]);
  });

  test("preserves a nested task kind filter on a default Lists view", () => {
    const layout = {
      version: 1,
      type: "kanban",
      filters: [
        {
          type: "group",
          combinator: "and",
          children: [
            {
              type: "predicate",
              operand: { type: "kind" },
              op: "in",
              value: ["task"],
            },
          ],
        },
      ],
      sorts: [],
      hiddenProperties: [],
      groupByPropertyId: "_status",
    } satisfies Extract<ViewLayout, { type: "kanban" }>;

    expect(
      normalizeDefaultViewLayout({
        layout,
        name: "Lists",
      }),
    ).toBe(layout);
  });

  test("seeds Todos as a task-scoped view while Legal Lists are disabled", () => {
    const views = getDefaultViews("en", { legalListsEnabled: false });
    const todosView = views.find((view) => view.name === "Todos");

    expect(todosView?.layout).toMatchObject({
      type: "kanban",
      filters: [
        {
          type: "predicate",
          operand: { type: "kind" },
          op: "in",
          value: ["task"],
        },
      ],
    });
  });
});
