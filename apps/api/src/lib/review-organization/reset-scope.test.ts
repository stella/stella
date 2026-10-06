import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";
import {
  REVIEW_RESET_CLEARED_TABLES,
  REVIEW_RESET_KEPT_TABLES,
  REVIEW_RESET_MANUAL_TABLES,
  REVIEW_RESET_MATTER_TABLE,
} from "@/api/lib/review-organization/reset-scope";

const isPgTable = (value: unknown): value is PgTable => is(value, PgTable);

/** Every table the schema declares, once, by its database name. */
const schemaExports: unknown[] = Object.values({ ...authSchema, ...schema });
const tables: ReadonlyMap<string, PgTable> = new Map(
  schemaExports
    .filter(isPgTable)
    .map((table) => [getTableConfig(table).name, table]),
);
const kept = new Set(Object.keys(REVIEW_RESET_KEPT_TABLES));
const cleared = new Set<string>(REVIEW_RESET_CLEARED_TABLES);

const columnNames = (table: PgTable) =>
  new Set(getTableConfig(table).columns.map((column) => column.name));

type Edge = { child: string; parent: string; onDelete: string | undefined };

const edges: Edge[] = [...tables.entries()].flatMap(([child, table]) =>
  getTableConfig(table).foreignKeys.map((key) => ({
    child,
    parent: getTableConfig(key.reference().foreignTable).name,
    onDelete: key.onDelete,
  })),
);

/** The tables a cascade from `roots` reaches, the roots included. */
const cascadeClosure = (roots: Iterable<string>): Set<string> => {
  const closure = new Set<string>(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (
        edge.onDelete === "cascade" &&
        closure.has(edge.parent) &&
        !closure.has(edge.child)
      ) {
        closure.add(edge.child);
        changed = true;
      }
    }
  }
  return closure;
};

/** Tables the reset empties: directly, by hand, with a matter, or by cascade. */
const clearedClosure = () =>
  cascadeClosure([
    ...REVIEW_RESET_CLEARED_TABLES,
    ...REVIEW_RESET_MANUAL_TABLES,
    REVIEW_RESET_MATTER_TABLE,
  ]);

/** Tables gone with the matters, before the sweep starts. */
const matterClosure = () => cascadeClosure([REVIEW_RESET_MATTER_TABLE]);

describe("review organization reset scope", () => {
  test("every listed table exists and has exactly one decision", () => {
    const listed = [
      ...REVIEW_RESET_CLEARED_TABLES,
      ...REVIEW_RESET_MANUAL_TABLES,
      REVIEW_RESET_MATTER_TABLE,
      ...kept,
    ];
    expect(listed.filter((name) => !tables.has(name))).toEqual([]);
    expect(listed.length).toBe(new Set(listed).size);
  });

  test("every organization-scoped table is cleared or kept with a reason", () => {
    const undecided = [...tables.entries()]
      .filter(([, table]) => columnNames(table).has("organization_id"))
      .map(([name]) => name)
      .filter(
        (name) =>
          !cleared.has(name) &&
          !kept.has(name) &&
          name !== REVIEW_RESET_MATTER_TABLE,
      );
    expect(undecided).toEqual([]);
  });

  test("every matter-scoped table is cleared with its matter or kept", () => {
    const closure = clearedClosure();
    const undecided = [...tables.entries()]
      .filter(([, table]) => columnNames(table).has("workspace_id"))
      .map(([name]) => name)
      .filter((name) => !closure.has(name) && !kept.has(name));
    expect(undecided).toEqual([]);
  });

  test("swept tables are only those that name their organization", () => {
    const unscoped = REVIEW_RESET_CLEARED_TABLES.filter((name) => {
      const table = tables.get(name);
      return table === undefined || !columnNames(table).has("organization_id");
    });
    expect(unscoped).toEqual([]);
  });

  test("no kept or outside table blocks the sweep with a restrictive reference", () => {
    const goneWithMatters = matterClosure();
    const blocking = edges.filter(
      (edge) =>
        cleared.has(edge.parent) &&
        edge.onDelete !== "cascade" &&
        edge.onDelete !== "set null" &&
        !cleared.has(edge.child) &&
        !goneWithMatters.has(edge.child) &&
        !REVIEW_RESET_MANUAL_TABLES.some((name) => name === edge.child),
    );
    expect(
      blocking.map(({ child, parent }) => `${child} -> ${parent}`),
    ).toEqual([]);
  });

  test("the delete order empties a restrictive child before its parent", () => {
    const position = new Map<string, number>(
      REVIEW_RESET_CLEARED_TABLES.map((name, index) => [name, index]),
    );
    const misordered = edges
      .filter(
        (edge) =>
          edge.child !== edge.parent &&
          cleared.has(edge.child) &&
          cleared.has(edge.parent) &&
          edge.onDelete !== "cascade" &&
          edge.onDelete !== "set null" &&
          (position.get(edge.child) ?? 0) > (position.get(edge.parent) ?? 0),
      )
      .map(({ child, parent }) => `${child} before ${parent}`);
    expect(misordered).toEqual([]);
  });
});
