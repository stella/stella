import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import path from "node:path";
import * as v from "valibot";

import * as agentAuthSchema from "@/api/db/agent-auth-schema";
import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";

import {
  isPgTable,
  tenantReferenceCount,
  unscopedTenantReferences,
} from "./tenant-scoped-references";
import ledgerData from "./tenant-scoped-references.json";

/**
 * Every foreign key from a tenant-owned table to another carries the tenant
 * column (see `tenant-scoped-references.ts` for the rule). The ledger lists
 * the references that do not yet; it is a progress meter that only shrinks,
 * one table family per change, and is deleted when it is empty.
 */

const ledgerSchema = v.object({
  $comment: v.string(),
  references: v.record(
    v.string(),
    v.object({
      family: v.pipe(v.string(), v.minLength(1)),
      reason: v.pipe(v.string(), v.minLength(20)),
    }),
  ),
});
type Ledger = v.InferOutput<typeof ledgerSchema>;

const ledger = v.parse(ledgerSchema, ledgerData);

const LEDGER_PATH = "apps/api/src/tests/security/tenant-scoped-references.json";
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");

const schemaTables = () => {
  // Annotated as `unknown` so the traversal does not infer a union of every
  // table type.
  const exports: Record<string, unknown> = {
    ...schema,
    ...authSchema,
    ...agentAuthSchema,
  };
  return [...new Set(Object.values(exports).filter(isPgTable))];
};

const readBaseLedger = (): Ledger | null => {
  const result = Bun.spawnSync(["git", "show", `origin/main:${LEDGER_PATH}`], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    return v.parse(ledgerSchema, JSON.parse(result.stdout.toString()));
  }
  const error = result.stderr.toString();
  if (/exists on disk, but not in|does not exist in/u.test(error)) {
    return null;
  }
  return panic(`Could not read the ledger baseline: ${error}`);
};

const compareLedger = (
  findings: readonly { reference: string }[],
  entries: Ledger["references"],
) => {
  const found = new Set(findings.map(({ reference }) => reference));
  return {
    unrecorded: [...found].filter((key) => !Object.hasOwn(entries, key)),
    stale: Object.keys(entries).filter((key) => !found.has(key)),
  };
};

describe("references between tenant-owned tables carry the tenant column", () => {
  const tables = schemaTables();
  const findings = unscopedTenantReferences(tables);

  test("the schema walk reaches the tenant references", () => {
    // A walk that found no references would pass every check below.
    expect(tenantReferenceCount(tables)).toBeGreaterThan(200);
  });

  test("every unscoped reference is in the ledger and every entry is still unscoped", () => {
    expect(compareLedger(findings, ledger.references)).toEqual({
      unrecorded: [],
      stale: [],
    });
  });

  test("each ledger entry names its target table as the family", () => {
    const misfiled = findings
      .filter(
        ({ reference, target }) =>
          ledger.references[reference] !== undefined &&
          ledger.references[reference].family !== target,
      )
      .map(({ reference }) => reference);
    expect(misfiled).toEqual([]);
  });

  test("the ledger only shrinks against the base branch", () => {
    const base = readBaseLedger();
    const added =
      base === null
        ? []
        : Object.keys(ledger.references).filter(
            (key) => !Object.hasOwn(base.references, key),
          );
    expect(added).toEqual([]);
  });
});

describe("the tenant reference rule", () => {
  const organizations = pgTable("organization", { id: text().primaryKey() });
  const parents = pgTable(
    "parents",
    {
      id: uuid().primaryKey(),
      organizationId: text("organization_id").notNull(),
    },
    (table) => [unique().on(table.organizationId, table.id)],
  );
  const keylessParents = pgTable("keyless_parents", {
    id: uuid().primaryKey(),
    organizationId: text("organization_id").notNull(),
  });
  const workspaces = pgTable("workspaces", {
    id: uuid().primaryKey(),
    organizationId: text("organization_id").notNull(),
  });

  const findingsOf = (
    ...tables: Parameters<typeof unscopedTenantReferences>[0]
  ) =>
    unscopedTenantReferences(tables).map(({ reference, problem }) => ({
      reference,
      problem,
    }));

  test("an id-only reference is reported", () => {
    const children = pgTable("children", {
      id: uuid().primaryKey(),
      organizationId: text("organization_id")
        .notNull()
        .references(() => organizations.id),
      parentId: uuid("parent_id").references(() => parents.id),
    });
    expect(findingsOf(children, parents, organizations)).toEqual([
      {
        reference: "children(parent_id) -> parents(id)",
        problem: "id-only",
      },
    ]);
  });

  test("a reference that carries the tenant column passes, alone or beside an id-only one", () => {
    const children = pgTable(
      "children",
      {
        id: uuid().primaryKey(),
        organizationId: text("organization_id").notNull(),
        parentId: uuid("parent_id").references(() => parents.id),
      },
      (table) => [
        foreignKey({
          columns: [table.organizationId, table.parentId],
          foreignColumns: [parents.organizationId, parents.id],
        }),
      ],
    );
    expect(findingsOf(children, parents)).toEqual([]);
  });

  test("a composite reference to a key the target does not declare unique is reported", () => {
    const children = pgTable(
      "children",
      {
        id: uuid().primaryKey(),
        organizationId: text("organization_id").notNull(),
        parentId: uuid("parent_id"),
      },
      (table) => [
        foreignKey({
          columns: [table.organizationId, table.parentId],
          foreignColumns: [keylessParents.organizationId, keylessParents.id],
        }),
      ],
    );
    expect(findingsOf(children, keylessParents)).toEqual([
      {
        reference:
          "children(organization_id,parent_id) -> keyless_parents(organization_id,id)",
        problem: "target-key-not-unique",
      },
    ]);
  });

  test("a nullable tenant column cannot bind a reference", () => {
    const children = pgTable(
      "children",
      {
        id: uuid().primaryKey(),
        organizationId: text("organization_id"),
        parentId: uuid("parent_id"),
      },
      (table) => [
        foreignKey({
          columns: [table.organizationId, table.parentId],
          foreignColumns: [parents.organizationId, parents.id],
        }),
      ],
    );
    expect(findingsOf(children, parents)).toEqual([
      {
        reference:
          "children(organization_id,parent_id) -> parents(organization_id,id)",
        problem: "nullable-tenant-column",
      },
    ]);
  });

  test("a nullable copy of the tenant column binds a reference only under the exact CHECK", () => {
    const tied = pgTable(
      "children",
      {
        id: uuid().primaryKey(),
        organizationId: text("organization_id").notNull(),
        parentId: uuid("parent_id"),
        parentOrganizationId: text("parent_organization_id"),
      },
      (table) => [
        foreignKey({
          columns: [table.parentId, table.parentOrganizationId],
          foreignColumns: [parents.id, parents.organizationId],
        }).onDelete("set null"),
        check(
          "children_parent_scope_check",
          sql`(${table.parentId} is null and ${table.parentOrganizationId} is null) or (${table.parentId} is not null and ${table.parentOrganizationId} = ${table.organizationId})`,
        ),
      ],
    );
    const loose = pgTable(
      "children",
      {
        id: uuid().primaryKey(),
        organizationId: text("organization_id").notNull(),
        parentId: uuid("parent_id"),
        parentOrganizationId: text("parent_organization_id"),
      },
      (table) => [
        foreignKey({
          columns: [table.parentId, table.parentOrganizationId],
          foreignColumns: [parents.id, parents.organizationId],
        }).onDelete("set null"),
        check(
          "children_parent_scope_check",
          sql`${table.parentOrganizationId} = ${table.organizationId} or ${table.parentId} is not null`,
        ),
      ],
    );
    expect(findingsOf(tied, parents)).toEqual([]);
    expect(findingsOf(loose, parents)).toEqual([
      {
        reference:
          "children(parent_id,parent_organization_id) -> parents(id,organization_id)",
        problem: "id-only",
      },
    ]);
  });

  test("a workspace-only table may name its workspace; any other cross-scope reference is reported", () => {
    const children = pgTable("children", {
      id: uuid().primaryKey(),
      workspaceId: uuid("workspace_id")
        .notNull()
        .references(() => workspaces.id),
      parentId: uuid("parent_id").references((): AnyPgColumn => parents.id),
    });
    expect(findingsOf(children, workspaces, parents)).toEqual([
      {
        reference: "children(parent_id) -> parents(id)",
        problem: "no-shared-tenant-column",
      },
    ]);
  });
});
