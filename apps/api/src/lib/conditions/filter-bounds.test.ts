/**
 * Every request `filters` array and every condition group is bounded by the
 * same constant. The depth bound in the condition contract limits nesting
 * only; without a per-array cap one request could carry an unbounded list of
 * predicates into the SQL builder.
 */

import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { VIEW_FILTERS_MAX } from "@stll/api-contract";
import type { ConditionNode, GroupNode } from "@stll/conditions";

import readEntities from "@/api/handlers/entities/list";
import readFilesystemTree from "@/api/handlers/entities/read-filesystem-tree";
import readKanbanGroup from "@/api/handlers/entities/read-kanban-group";
import readPropertyFacets from "@/api/handlers/entities/read-property-facets";
import readEntitiesWindow from "@/api/handlers/entities/read-window";
import calendarTasks from "@/api/handlers/tasks/calendar";
import { tCondition, tConditionNode } from "@/api/lib/conditions/contract";
import { LIMITS } from "@/api/lib/limits";
import {
  parseViewLayoutSafe,
  tViewLayoutSchema,
  viewLayoutSchema,
} from "@/api/lib/views-schema";

const leaf: ConditionNode = {
  type: "predicate",
  operand: { type: "builtin", field: "status" },
  op: "is_empty",
};

const leaves = (count: number): ConditionNode[] =>
  Array.from({ length: count }, () => leaf);

const group = (children: ConditionNode[]): GroupNode => ({
  type: "group",
  combinator: "and",
  children,
});

/** Body fields each route needs beyond `filters`, so the only reason a
 *  check can fail is the filter bound itself. */
const FILTER_ROUTES = {
  "entities.list": { handler: readEntities, body: {} },
  "entities.read-window": { handler: readEntitiesWindow, body: {} },
  "entities.read-filesystem-tree": { handler: readFilesystemTree, body: {} },
  "entities.read-kanban-group": {
    handler: readKanbanGroup,
    body: {
      groupByPropertyId: "00000000-0000-4000-8000-000000000301",
      groupValue: "open",
    },
  },
  "entities.read-property-facets": {
    handler: readPropertyFacets,
    body: { propertyId: "00000000-0000-4000-8000-000000000301" },
  },
  "tasks.calendar": {
    handler: calendarTasks,
    body: {
      dateFrom: "2026-01-01T00:00:00.000Z",
      dateTo: "2026-01-31T00:00:00.000Z",
      datePropertyIds: ["_created-at"],
    },
  },
} as const;

describe("request filter arrays", () => {
  test("the route bound is the shared view filter bound", () => {
    expect(LIMITS.viewFiltersCount).toBe(VIEW_FILTERS_MAX);
  });

  for (const [route, { handler, body }] of Object.entries(FILTER_ROUTES)) {
    test(`${route} accepts ${VIEW_FILTERS_MAX} filters and rejects one more`, () => {
      const schema = handler.config.body;
      const atCap = { ...body, filters: leaves(VIEW_FILTERS_MAX) };
      const overCap = { ...body, filters: leaves(VIEW_FILTERS_MAX + 1) };

      expect(Value.Check(schema, { ...body, filters: [] })).toBe(true);
      expect(Value.Check(schema, atCap)).toBe(true);
      expect(Value.Check(schema, overCap)).toBe(false);
      expect(
        [...Value.Errors(schema, overCap)].map((error) => error.path),
      ).toContain("/filters");
    });
  }
});

describe("condition group fan-out", () => {
  test("a group accepts the bound and rejects one more child", () => {
    expect(Value.Check(tConditionNode, group(leaves(VIEW_FILTERS_MAX)))).toBe(
      true,
    );
    expect(
      Value.Check(tConditionNode, group(leaves(VIEW_FILTERS_MAX + 1))),
    ).toBe(false);
  });

  test("a nested group is bounded the same way", () => {
    expect(
      Value.Check(tConditionNode, group([group(leaves(VIEW_FILTERS_MAX))])),
    ).toBe(true);
    expect(
      Value.Check(tConditionNode, group([group(leaves(VIEW_FILTERS_MAX + 1))])),
    ).toBe(false);
  });

  test("the root condition is bounded", () => {
    expect(Value.Check(tCondition, group(leaves(VIEW_FILTERS_MAX)))).toBe(true);
    expect(Value.Check(tCondition, group(leaves(VIEW_FILTERS_MAX + 1)))).toBe(
      false,
    );
  });
});

describe("view layout filters", () => {
  const layoutWith = (filters: ConditionNode[]) => ({
    version: 1,
    type: "table",
    filters,
    sorts: [],
    hiddenProperties: [],
    calculations: [],
    columnOrder: ["name"],
    columnPinning: [],
  });

  test("the route schema accepts the bound and rejects one more", () => {
    expect(
      Value.Check(tViewLayoutSchema, layoutWith(leaves(VIEW_FILTERS_MAX))),
    ).toBe(true);
    expect(
      Value.Check(tViewLayoutSchema, layoutWith(leaves(VIEW_FILTERS_MAX + 1))),
    ).toBe(false);
  });

  test("the stored schema rejects past the bound and the safe parser keeps the leading filters", () => {
    expect(v.is(viewLayoutSchema, layoutWith(leaves(VIEW_FILTERS_MAX)))).toBe(
      true,
    );
    const overCap = layoutWith(leaves(VIEW_FILTERS_MAX + 1));
    expect(v.is(viewLayoutSchema, overCap)).toBe(false);
    expect(parseViewLayoutSafe(overCap).filters).toHaveLength(VIEW_FILTERS_MAX);
  });
});
