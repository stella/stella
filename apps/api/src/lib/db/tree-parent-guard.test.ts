import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as p from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import * as agentAuthSchema from "@/api/db/agent-auth-schema";
import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";

import {
  SELF_REFERENCE_EXEMPTIONS,
  TREE_PARENT_GUARDS,
  treeParentTriggerArguments,
} from "./tree-parent-guard";

/**
 * Every foreign key from a table to itself is a tree a writer can reparent,
 * so it either carries the `guard_tree_parent` trigger (a registered tree) or
 * names, in the exemptions, why it cannot form a loop. A new self-reference
 * fails here until it picks one.
 */

type SelfReference = { table: string; column: string; references: string };

const selfReferences = (tables: readonly unknown[]): SelfReference[] =>
  tables.flatMap((value) => {
    if (!is(value, PgTable)) {
      return [];
    }
    const config = getTableConfig(value);
    return config.foreignKeys.flatMap((foreignKey) => {
      const reference = foreignKey.reference();
      if (reference.foreignTable !== value) {
        return [];
      }
      return [
        {
          table: config.name,
          column: reference.columns.map((column) => column.name).join(","),
          references: reference.foreignColumns
            .map((column) => column.name)
            .join(","),
        },
      ];
    });
  });

const registered = new Map(
  Object.values(TREE_PARENT_GUARDS).map((guard) => [
    `${guard.table}.parent_id`,
    guard,
  ]),
);

const unguardedSelfReferences = (references: readonly SelfReference[]) =>
  references
    .map((reference) => `${reference.table}.${reference.column}`)
    .filter(
      (key) =>
        !registered.has(key) && SELF_REFERENCE_EXEMPTIONS[key] === undefined,
    );

const schemaTables = Object.values({
  ...schema,
  ...authSchema,
  ...agentAuthSchema,
});

describe("self-referencing trees", () => {
  test("every self-referencing foreign key is a guarded tree or a reasoned exemption", () => {
    expect(unguardedSelfReferences(selfReferences(schemaTables))).toEqual([]);
  });

  test("every registered tree is a parent_id -> id self-reference in the schema", () => {
    const found = new Set(
      selfReferences(schemaTables)
        .filter((reference) => reference.references === "id")
        .map((reference) => `${reference.table}.${reference.column}`),
    );
    expect([...registered.keys()].filter((key) => !found.has(key))).toEqual([]);
  });

  test("every exemption names a self-reference that still exists, with a reason", () => {
    const found = new Set(
      selfReferences(schemaTables).map(
        (reference) => `${reference.table}.${reference.column}`,
      ),
    );
    for (const [key, reason] of Object.entries(SELF_REFERENCE_EXEMPTIONS)) {
      expect({ key, exists: found.has(key) }).toEqual({ key, exists: true });
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  // The scan above must be able to fail: a new tree without the trigger.
  test("the scan reports a self-referencing table that is not registered", () => {
    const folders = p.pgTable("unregistered_folders", {
      id: p.uuid("id").primaryKey(),
      parentId: p
        .uuid("parent_id")
        .references((): AnyPgColumn => folders.id, { onDelete: "set null" }),
    });
    const notes = p.pgTable("unregistered_notes", {
      id: p.uuid("id").primaryKey(),
      folderId: p.uuid("folder_id").references(() => folders.id),
    });

    expect(unguardedSelfReferences(selfReferences([folders, notes]))).toEqual([
      "unregistered_folders.parent_id",
    ]);
  });
});

/**
 * The trigger arguments are written in migration SQL. The newest CREATE
 * TRIGGER for each tree must carry exactly what the registry derives, so the
 * lock the handlers take and the lock the trigger takes are one key.
 */
const DRIZZLE_DIR = nodePath.resolve(import.meta.dir, "../../../drizzle");

const newestTriggerStatement = (triggerName: string): string | undefined =>
  readdirSync(DRIZZLE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
    .flatMap((directory) =>
      readFileSync(
        nodePath.join(DRIZZLE_DIR, directory, "migration.sql"),
        "utf-8",
      )
        .split("--> statement-breakpoint")
        .filter((statement) =>
          statement.includes(`CREATE TRIGGER "${triggerName}"`),
        ),
    )
    .at(-1);

const triggerArguments = (statement: string): string[] | undefined => {
  const call = /"guard_tree_parent"\((?<args>[^)]*)\)/u.exec(statement)
    ?.groups?.["args"];
  return call
    ?.split(",")
    .map((argument) =>
      argument.trim().replace(/^'(?<value>.*)'$/u, "$<value>"),
    );
};

describe("tree trigger migrations", () => {
  for (const [tree, guard] of Object.entries(TREE_PARENT_GUARDS)) {
    test(`${tree}: the migration installs the trigger with the registry's arguments`, () => {
      const statement = newestTriggerStatement(guard.constraint);
      expect(statement).toBeDefined();
      expect(statement).toContain(
        `AFTER INSERT OR UPDATE OF "parent_id" ON "${guard.table}"`,
      );
      expect(triggerArguments(statement ?? "")).toEqual([
        ...treeParentTriggerArguments(guard),
      ]);
    });
  }
});
