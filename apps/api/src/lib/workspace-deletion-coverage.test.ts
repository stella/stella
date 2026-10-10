import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import {
  foreignKey,
  getTableConfig,
  pgTable,
  PgTable,
  text,
} from "drizzle-orm/pg-core";
import type { PgColumn } from "drizzle-orm/pg-core";

import * as authSchema from "@/api/db/auth-schema";
import { entityFeatureGateMetadata } from "@/api/db/entity-feature-gate-metadata";
import * as schema from "@/api/db/schema";
import { workspaces } from "@/api/db/schema";
import {
  WORKSPACE_DELETION_MANUAL_TABLES,
  WORKSPACE_STORAGE_CLASS,
  WORKSPACE_STORAGE_DISPOSITION,
  WORKSPACE_STORAGE_REFERENCE_DISPOSITION,
  workspaceDerivedReferenceDisposition,
} from "@/api/lib/organization-storage-teardown";

const isPgTable = (value: unknown): value is PgTable => is(value, PgTable);
const allSchemaExports: Record<string, unknown> = { ...authSchema, ...schema };
const allTables = Object.values(allSchemaExports).filter(isPgTable);

type ForeignKeyEdge = {
  child: PgTable;
  columns: PgColumn[];
  foreignColumns: PgColumn[];
  onDelete: string | undefined;
  parent: PgTable;
};

const foreignKeyEdges = (): ForeignKeyEdge[] =>
  allTables.flatMap((child) =>
    getTableConfig(child).foreignKeys.map((key) => ({
      child,
      columns: key.reference().columns,
      foreignColumns: key.reference().foreignColumns,
      onDelete: key.onDelete,
      parent: key.reference().foreignTable,
    })),
  );

// MATCH SIMPLE exempts a composite FK after a matching nullable pointer is
// cleared. RESTRICT checks may run before referential actions and are not safe.
const clearedBySiblingForeignKey = (
  edge: ForeignKeyEdge,
  edges: ForeignKeyEdge[],
) =>
  (edge.onDelete === "no action" || edge.onDelete === undefined) &&
  edges.some(
    (sibling) =>
      sibling.child === edge.child &&
      sibling.parent === edge.parent &&
      sibling.onDelete === "set null" &&
      sibling.columns.length > 0 &&
      sibling.columns.every((column, index) => {
        if (column.notNull) {
          return false;
        }
        const pairedParent = sibling.foreignColumns.at(index);
        return edge.columns.some(
          (edgeColumn, edgeIndex) =>
            edgeColumn.name === column.name &&
            edge.foreignColumns.at(edgeIndex)?.name === pairedParent?.name,
        );
      }),
  );

const deletionClosure = (): Set<PgTable> => {
  const closure = new Set<PgTable>([
    workspaces,
    ...WORKSPACE_DELETION_MANUAL_TABLES,
  ]);
  const edges = foreignKeyEdges();
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

describe("workspace deletion coverage", () => {
  test("the schema walk sees known dependants across the workspace graph", () => {
    const directChildren = new Set(
      foreignKeyEdges()
        .filter((edge) => edge.parent === workspaces)
        .map((edge) => getTableConfig(edge.child).name),
    );
    expect(directChildren.has("chat_threads")).toBe(true);
    expect(directChildren.has("desktop_edit_sessions")).toBe(true);
    expect(directChildren.has("pdf_signing_sessions")).toBe(true);
    expect(directChildren.has("signals")).toBe(true);
    expect(directChildren.has("notifications")).toBe(true);
  });

  test("every restrictive edge into the deletion closure is manually or transitively covered", () => {
    const closure = deletionClosure();
    const edges = foreignKeyEdges();
    const uncovered = edges.filter(
      (edge) =>
        closure.has(edge.parent) &&
        edge.onDelete !== "cascade" &&
        edge.onDelete !== "set null" &&
        !clearedBySiblingForeignKey(edge, edges) &&
        !closure.has(edge.child),
    );
    expect(
      uncovered.map(
        (edge) =>
          `${getTableConfig(edge.child).name} -> ${getTableConfig(edge.parent).name}`,
      ),
    ).toEqual([]);
  });

  test("manual tables still close a restrictive edge", () => {
    const closure = deletionClosure();
    const edges = foreignKeyEdges();
    const stale = WORKSPACE_DELETION_MANUAL_TABLES.filter(
      (table) =>
        !edges.some(
          (edge) =>
            edge.child === table &&
            closure.has(edge.parent) &&
            edge.onDelete !== "cascade" &&
            edge.onDelete !== "set null" &&
            !clearedBySiblingForeignKey(edge, edges),
        ),
    );
    expect(stale.map((table) => getTableConfig(table).name)).toEqual([]);
  });

  test("derived workspace-id columns have an exact retention disposition", () => {
    const derivedWorkspaceColumns = allTables.flatMap((table) => {
      const tableName = getTableConfig(table).name;
      return getTableConfig(table)
        .columns.filter(
          (column) =>
            column.name.endsWith("workspace_ids") ||
            column.name.endsWith("matter_ids"),
        )
        .map((column) => `${tableName}.${column.name}`);
    });
    expect(derivedWorkspaceColumns.toSorted()).toEqual(
      Object.keys(workspaceDerivedReferenceDisposition(allTables)).toSorted(),
    );
  });

  test("workspace feature-gate scopes belong to rows removed by the cascade", () => {
    const cascadeClosure = new Set(
      [...deletionClosure()].map((table) => getTableConfig(table).name),
    );
    const outsideCascade = entityFeatureGateMetadata(allTables)
      .filter(({ needsWorkspace }) => needsWorkspace)
      .map(({ tableName }) => tableName)
      .filter((tableName) => !cascadeClosure.has(tableName));
    expect(outsideCascade).toEqual([]);
  });

  test("every known workspace storage class has an explicit disposition", () => {
    expect(Object.keys(WORKSPACE_STORAGE_DISPOSITION).toSorted()).toEqual(
      Object.values(WORKSPACE_STORAGE_CLASS).toSorted(),
    );
    expect(
      Object.entries(WORKSPACE_STORAGE_DISPOSITION).filter(
        ([, disposition]) => disposition === "cleanup-request",
      ).length,
    ).toBe(7);
    expect(
      WORKSPACE_STORAGE_DISPOSITION[WORKSPACE_STORAGE_CLASS.REPORT_EXPORT],
    ).toBe("bucket-lifecycle");
  });

  test("workspace-owned storage references have an exact disposition", () => {
    const closure = deletionClosure();
    const storageReferenceColumns = [...closure].flatMap((table) => {
      const tableName = getTableConfig(table).name;
      return getTableConfig(table)
        .columns.filter(
          (column) =>
            // A whole `file_id` word: `seller_profile_id` ends in the same
            // letters but names a seller profile, not a stored file.
            column.name === "file_id" ||
            column.name.endsWith("_file_id") ||
            column.name.endsWith("s3_key") ||
            column.name === "purpose_data" ||
            (tableName === "fields" && column.name === "content") ||
            (tableName === "document_processing_runs" && column.name === "id"),
        )
        .map((column) => `${tableName}.${column.name}`);
    });
    storageReferenceColumns.push("buffer_object_cleanup_intents.object_key");

    expect(storageReferenceColumns.toSorted()).toEqual(
      Object.keys(WORKSPACE_STORAGE_REFERENCE_DISPOSITION).toSorted(),
    );
  });
});

const pointerParent = pgTable("coverage_parent", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull(),
});
const pointerChild = pgTable(
  "coverage_child",
  {
    parentId: text("parent_id").references(() => pointerParent.id, {
      onDelete: "set null",
    }),
    organizationId: text("organization_id").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId, table.organizationId],
      foreignColumns: [pointerParent.id, pointerParent.organizationId],
    }),
  ],
);
const pointerEdges = getTableConfig(pointerChild).foreignKeys.map((key) => ({
  child: pointerChild,
  parent: key.reference().foreignTable,
  columns: key.reference().columns,
  foreignColumns: key.reference().foreignColumns,
  onDelete: key.onDelete,
}));

test("nullable matching SET NULL pointers cover NO ACTION composite checks only", () => {
  const composite = pointerEdges.find((edge) => edge.columns.length === 2);
  const pointer = pointerEdges.find((edge) => edge.columns.length === 1);
  expect(composite).toBeDefined();
  expect(pointer).toBeDefined();
  if (!composite || !pointer) {
    return;
  }
  expect(clearedBySiblingForeignKey(composite, pointerEdges)).toBe(true);
  expect(clearedBySiblingForeignKey(composite, [composite])).toBe(false);
  expect(
    clearedBySiblingForeignKey(
      { ...composite, onDelete: "restrict" },
      pointerEdges,
    ),
  ).toBe(false);
  expect(
    clearedBySiblingForeignKey(composite, [
      {
        ...pointer,
        columns: [pointerChild.organizationId],
        foreignColumns: [pointerParent.organizationId],
      },
    ]),
  ).toBe(false);
  expect(
    clearedBySiblingForeignKey(composite, [
      { ...pointer, foreignColumns: [pointerParent.organizationId] },
    ]),
  ).toBe(false);
  expect(
    clearedBySiblingForeignKey(composite, [{ ...pointer, parent: workspaces }]),
  ).toBe(false);
  expect(
    clearedBySiblingForeignKey(composite, [{ ...pointer, child: workspaces }]),
  ).toBe(false);
  expect(
    clearedBySiblingForeignKey(composite, [
      { ...pointer, onDelete: "no action" },
    ]),
  ).toBe(false);
});
