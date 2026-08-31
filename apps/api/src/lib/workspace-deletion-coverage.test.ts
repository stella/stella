import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";
import { workspaces } from "@/api/db/schema";
import {
  WORKSPACE_DERIVED_REFERENCE_DISPOSITION,
  WORKSPACE_DELETION_MANUAL_TABLES,
  WORKSPACE_STORAGE_CLASS,
  WORKSPACE_STORAGE_DISPOSITION,
  WORKSPACE_STORAGE_REFERENCE_DISPOSITION,
} from "@/api/lib/organization-storage-teardown";

const isPgTable = (value: unknown): value is PgTable => is(value, PgTable);
const allSchemaExports: Record<string, unknown> = { ...authSchema, ...schema };
const allTables = Object.values(allSchemaExports).filter(isPgTable);

type ForeignKeyEdge = {
  child: PgTable;
  onDelete: string | undefined;
  parent: PgTable;
};

const foreignKeyEdges = (): ForeignKeyEdge[] =>
  allTables.flatMap((child) =>
    getTableConfig(child).foreignKeys.map((foreignKey) => ({
      child,
      onDelete: foreignKey.onDelete,
      parent: foreignKey.reference().foreignTable,
    })),
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
  test("the schema walk is non-vacuous and sees the full direct workspace graph", () => {
    const directChildren = new Set(
      foreignKeyEdges()
        .filter((edge) => edge.parent === workspaces)
        .map((edge) => getTableConfig(edge.child).name),
    );
    expect(directChildren.size).toBe(52);
    expect(directChildren.has("chat_threads")).toBe(true);
    expect(directChildren.has("desktop_edit_sessions")).toBe(true);
    expect(directChildren.has("signals")).toBe(true);
    expect(directChildren.has("notifications")).toBe(true);
  });

  test("every restrictive edge into the deletion closure is manually or transitively covered", () => {
    const closure = deletionClosure();
    const uncovered = foreignKeyEdges().filter(
      (edge) =>
        closure.has(edge.parent) &&
        edge.onDelete !== "cascade" &&
        edge.onDelete !== "set null" &&
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
            edge.onDelete !== "set null",
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
    expect(derivedWorkspaceColumns.sort()).toEqual(
      Object.keys(WORKSPACE_DERIVED_REFERENCE_DISPOSITION).sort(),
    );
  });

  test("every known workspace storage class has an explicit disposition", () => {
    expect(Object.keys(WORKSPACE_STORAGE_DISPOSITION).sort()).toEqual(
      Object.values(WORKSPACE_STORAGE_CLASS).sort(),
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
            column.name.endsWith("file_id") ||
            column.name.endsWith("s3_key") ||
            column.name === "purpose_data" ||
            (tableName === "fields" && column.name === "content") ||
            (tableName === "document_processing_runs" && column.name === "id"),
        )
        .map((column) => `${tableName}.${column.name}`);
    });
    storageReferenceColumns.push("buffer_object_cleanup_intents.object_key");

    expect(storageReferenceColumns.sort()).toEqual(
      Object.keys(WORKSPACE_STORAGE_REFERENCE_DISPOSITION).sort(),
    );
  });
});
