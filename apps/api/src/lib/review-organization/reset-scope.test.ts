import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";
import { WORKSPACE_DELETION_RETAINED_TABLES } from "@/api/lib/organization-storage-teardown";
import {
  REVIEW_RESET_BILLING_TABLES,
  REVIEW_RESET_CLEARED_TABLES,
  REVIEW_RESET_KEPT_TABLES,
  REVIEW_RESET_MANUAL_TABLES,
  REVIEW_RESET_MATTER_TABLE,
  REVIEW_RESET_SHARED_STATEMENTS,
} from "@/api/lib/review-organization/reset-scope";
import { TABLE_POLICY_SETTINGS_BASELINE } from "@/api/tests/security/table-policy-settings-baseline";

const isPgTable = (value: unknown): value is PgTable => is(value, PgTable);

/** Every table the schema declares, once, by its database name. */
const schemaExports: unknown[] = Object.values({ ...authSchema, ...schema });
const tables: ReadonlyMap<string, PgTable> = new Map(
  schemaExports
    .filter(isPgTable)
    .map((table) => [getTableConfig(table).name, table]),
);
const kept = new Set(Object.keys(REVIEW_RESET_KEPT_TABLES));
/** Every table the reset deletes by name: billing records first, then the sweep. */
const deleteOrder: readonly string[] = [
  ...REVIEW_RESET_BILLING_TABLES,
  ...REVIEW_RESET_CLEARED_TABLES,
];
const cleared = new Set<string>(deleteOrder);

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
    ...deleteOrder,
    ...REVIEW_RESET_MANUAL_TABLES,
    REVIEW_RESET_MATTER_TABLE,
  ]);

/** Tables gone with the matters, before the sweep starts. */
const matterClosure = () => cascadeClosure([REVIEW_RESET_MATTER_TABLE]);

describe("review organization reset scope", () => {
  test("every listed table exists and has exactly one decision", () => {
    const listed = [
      ...deleteOrder,
      ...REVIEW_RESET_MANUAL_TABLES,
      REVIEW_RESET_MATTER_TABLE,
      ...kept,
    ];
    expect(listed.filter((name) => !tables.has(name))).toEqual([]);
    expect(listed.length).toBe(new Set(listed).size);
  });

  test("a shared sweep statement holds swept tables that stand together in the sweep order", () => {
    const order: readonly string[] = REVIEW_RESET_CLEARED_TABLES;
    const grouped = REVIEW_RESET_SHARED_STATEMENTS.flat();
    expect(grouped.length).toBe(new Set(grouped).size);
    for (const group of REVIEW_RESET_SHARED_STATEMENTS) {
      expect(group.length).toBeGreaterThan(1);
      const start = order.indexOf(group[0] ?? "");
      expect(start).toBeGreaterThanOrEqual(0);
      expect(order.slice(start, start + group.length)).toEqual([...group]);
    }
  });

  test("every organization-scoped table is cleared or kept with a reason", () => {
    // Cleared means swept by name, or removed by a cascade from the matters
    // the authorized matter deletion takes first.
    const goneWithMatters = matterClosure();
    const goneWithBilling = cascadeClosure(REVIEW_RESET_BILLING_TABLES);
    const undecided = [...tables.entries()]
      .filter(([, table]) => columnNames(table).has("organization_id"))
      .map(([name]) => name)
      .filter(
        (name) =>
          !cleared.has(name) &&
          !kept.has(name) &&
          !goneWithMatters.has(name) &&
          !goneWithBilling.has(name),
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

  test("invoice records admit the owner-fenced reset independently of matter visibility", () => {
    for (const name of ["invoices", "invoice_lines"]) {
      const table = tables.get(name);
      expect(table, name).toBeDefined();
      const policyNames = new Set(
        table === undefined
          ? []
          : getTableConfig(table).policies.map(({ name: policy }) => policy),
      );
      expect(policyNames.has("review_reset_owner_select"), name).toBe(true);
      expect(policyNames.has("review_reset_owner_delete"), name).toBe(true);
    }
  });

  test("swept tables are only those that name their organization", () => {
    const unscoped = deleteOrder.filter((name) => {
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

  test("billing records a matter deletion refuses are cleared before the matters", () => {
    const retained = WORKSPACE_DELETION_RETAINED_TABLES.map(
      (table) => getTableConfig(table).name,
    );
    // The named roots and their cascades are exactly the retained tables.
    expect(
      [...cascadeClosure(REVIEW_RESET_BILLING_TABLES)]
        .filter((name) => retained.includes(name))
        .toSorted(),
    ).toEqual(retained.toSorted());
    // The owner deletes them, so none may force row security on its owner.
    const unforced = new Set(TABLE_POLICY_SETTINGS_BASELINE);
    expect(
      REVIEW_RESET_BILLING_TABLES.filter((name) => !unforced.has(name)),
    ).toEqual([]);
    // A stage deletes its tables in one statement: a RESTRICT among them
    // would be checked before its row's own delete.
    const billing = new Set<string>(retained);
    expect(
      edges
        .filter(
          (edge) =>
            billing.has(edge.parent) &&
            billing.has(edge.child) &&
            edge.onDelete === "restrict",
        )
        .map(({ child, parent }) => `${child} -> ${parent}`),
    ).toEqual([]);
    // While the matters still stand, nothing outside the retained set may
    // hold a billing row back with a restrictive reference.
    const blocking = edges.filter(
      (edge) =>
        billing.has(edge.parent) &&
        !billing.has(edge.child) &&
        edge.onDelete !== "cascade" &&
        edge.onDelete !== "set null",
    );
    expect(
      blocking.map(({ child, parent }) => `${child} -> ${parent}`),
    ).toEqual([]);
  });

  test("the delete order empties a restrictive child before its parent", () => {
    const position = new Map<string, number>(
      deleteOrder.map((name, index) => [name, index]),
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
