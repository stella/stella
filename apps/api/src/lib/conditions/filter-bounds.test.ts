/**
 * Every request `filters` array and every condition group is bounded by the
 * same constant. The depth bound in the condition contract limits nesting
 * only; without a per-array cap one request could carry an unbounded list of
 * predicates into the SQL builder.
 *
 * The set of consumers is a census, not a hand list: every non-test module
 * under `apps/api/src` that imports the condition contract must have a probe
 * here, and every probe must name a module the census finds, so a new filter
 * endpoint cannot land unbounded.
 */

import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { VIEW_FILTERS_MAX } from "@stll/api-contract";
import type { ConditionNode, GroupNode } from "@stll/conditions";

import readEntities from "@/api/handlers/entities/list";
import readFilesystemTree from "@/api/handlers/entities/read-filesystem-tree";
import readGroupCounts from "@/api/handlers/entities/read-group-counts";
import readKanbanGroup from "@/api/handlers/entities/read-kanban-group";
import readPropertyFacets from "@/api/handlers/entities/read-property-facets";
import readEntitiesWindow from "@/api/handlers/entities/read-window";
import markColumnFlag from "@/api/handlers/fields/mark-column-flag";
import updateProperty from "@/api/handlers/properties/update";
import calendarTasks from "@/api/handlers/tasks/calendar";
import { tCondition, tConditionNode } from "@/api/lib/conditions/contract";
import { LIMITS } from "@/api/lib/limits";
import { createPropertyBodySchema } from "@/api/lib/properties/create-schema";
import {
  parseViewLayoutSafe,
  tViewLayoutSchema,
  tViewTemplatePropertySchema,
  viewLayoutSchema,
} from "@/api/lib/views-schema";
import { positionRuleSchema } from "@/api/lib/workflow/playbook-position-facets";
import { deterministicCheckSchema } from "@/api/lib/workflow/playbook-positions";

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

const PROPERTY_ID = "00000000-0000-4000-8000-000000000301";

/** A module's schema plus where a list of `count` predicates lands in it:
 *  as a `filters` array for list-shaped bodies, as one group's children for
 *  single-condition slots. Either way the bound is `VIEW_FILTERS_MAX`. */
type Probe = {
  schema: TSchema;
  place: (nodes: ConditionNode[]) => unknown;
};

const filters = (
  schema: TSchema,
  rest: Record<string, unknown> = {},
): Probe => ({
  schema,
  place: (nodes) => ({ ...rest, filters: nodes }),
});

/** Keyed by module path relative to `apps/api/src`, without extension. */
const PROBES: Record<string, Probe[]> = {
  "handlers/entities/list": [filters(readEntities.config.body)],
  "handlers/entities/read-window": [filters(readEntitiesWindow.config.body)],
  "handlers/entities/read-filesystem-tree": [
    filters(readFilesystemTree.config.body),
  ],
  "handlers/entities/read-kanban-group": [
    filters(readKanbanGroup.config.body, {
      groupByPropertyId: PROPERTY_ID,
      groupValue: "open",
    }),
  ],
  "handlers/entities/read-property-facets": [
    filters(readPropertyFacets.config.body, { propertyId: PROPERTY_ID }),
  ],
  "handlers/entities/read-group-counts": [
    filters(readGroupCounts.config.body, { groupByPropertyId: "_status" }),
  ],
  "handlers/fields/mark-column-flag": [
    filters(markColumnFlag.config.body, {
      propertyId: PROPERTY_ID,
      flag: "verified",
    }),
  ],
  "handlers/tasks/calendar": [
    filters(calendarTasks.config.body, {
      dateFrom: "2026-01-01T00:00:00.000Z",
      dateTo: "2026-01-31T00:00:00.000Z",
      datePropertyIds: ["_created-at"],
    }),
  ],
  "handlers/properties/update": [
    {
      schema: updateProperty.config.body,
      place: (nodes) => ({
        name: "Summary",
        content: { version: 1, type: "text" },
        tool: {
          version: 1,
          type: "ai-model",
          prompt: "summarise",
          dependencies: [
            { dependsOnPropertyId: PROPERTY_ID, condition: group(nodes) },
          ],
        },
      }),
    },
  ],
  "lib/properties/create-schema": [
    {
      schema: createPropertyBodySchema,
      place: (nodes) => ({
        name: "Summary",
        contentType: "text",
        dependencies: [
          { dependsOnPropertyId: PROPERTY_ID, condition: group(nodes) },
        ],
      }),
    },
  ],
  "lib/views-schema": [
    {
      schema: tViewLayoutSchema,
      place: (nodes) => ({
        version: 1,
        type: "table",
        filters: nodes,
        sorts: [],
        hiddenProperties: [],
        calculations: [],
        columnOrder: ["name"],
        columnPinning: [],
      }),
    },
    {
      schema: tViewTemplatePropertySchema,
      place: (nodes) => ({
        version: 1,
        sourceId: "summary",
        name: "Summary",
        content: { version: 1, type: "text" },
        tool: { version: 1, type: "ai-model", prompt: "summarise" },
        createIfMissing: true,
        dependencies: [
          { dependsOnSourceId: "source", condition: group(nodes) },
        ],
      }),
    },
  ],
  "lib/workflow/playbook-position-facets": [
    {
      schema: positionRuleSchema,
      place: (nodes) => ({
        kind: "propertyConstraint",
        condition: group(nodes),
      }),
    },
  ],
  "lib/workflow/playbook-positions": [
    {
      schema: deterministicCheckSchema,
      place: (nodes) => ({ kind: "constraint", condition: group(nodes) }),
    },
  ],
};

const API_SRC = path.join(import.meta.dir, "..", "..");
const CONTRACT_MODULE = "lib/conditions/contract";
const CONTRACT_IMPORT = `"@/api/${CONTRACT_MODULE}"`;
const CONTRACT_SCHEMA = /\bt(?:Condition|ConditionNode)\b/u;

/** Non-test modules that import a schema from the condition contract. */
const discoverConsumers = (): string[] => {
  const modules: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(API_SRC)) {
    if (file.endsWith(".test.ts") || file.endsWith(".d.ts")) {
      continue;
    }
    const module = file.slice(0, -".ts".length);
    if (module === CONTRACT_MODULE) {
      continue;
    }
    const source = readFileSync(path.join(API_SRC, file), "utf-8");
    if (source.includes(CONTRACT_IMPORT) && CONTRACT_SCHEMA.test(source)) {
      modules.push(module);
    }
  }
  return modules.sort();
};

describe("condition consumer census", () => {
  test("the route bound is the shared view filter bound", () => {
    expect(LIMITS.viewFiltersCount).toBe(VIEW_FILTERS_MAX);
  });

  test("every module importing the contract is probed, and only those", () => {
    const discovered = discoverConsumers();
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered).toEqual(Object.keys(PROBES).sort());
  });

  for (const [module, probes] of Object.entries(PROBES)) {
    for (const [index, { schema, place }] of probes.entries()) {
      test(`${module}#${index} accepts ${VIEW_FILTERS_MAX} predicates and rejects one more`, () => {
        expect(Value.Check(schema, place([]))).toBe(true);
        expect(Value.Check(schema, place(leaves(VIEW_FILTERS_MAX)))).toBe(true);
        expect(Value.Check(schema, place(leaves(VIEW_FILTERS_MAX + 1)))).toBe(
          false,
        );
      });
    }
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

describe("stored view layout filters", () => {
  const layoutWith = (nodes: ConditionNode[]) => ({
    version: 1,
    type: "table",
    filters: nodes,
    sorts: [],
    hiddenProperties: [],
    calculations: [],
    columnOrder: ["name"],
    columnPinning: [],
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
