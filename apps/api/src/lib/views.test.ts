import { describe, expect, test } from "bun:test";

import { convertLayout } from "@/api/handlers/views/utils";
import { getDefaultViews, normalizeDefaultViewLayout } from "@/api/lib/views";
import type { ViewLayout } from "@/api/lib/views-schema";

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
    const views = getDefaultViews("en");
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
      normalizeDefaultViewLayout({ layout: legacyLayout, name: "Todos" }),
    ).toMatchObject({ filters: [{ operand: { type: "kind" } }] });
    expect(
      normalizeDefaultViewLayout({ layout: legacyLayout, name: "My board" }),
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
});
