import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  pgPolicy,
  pgTable,
  pgSchema,
  pgView,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import * as schema from "@/api/db/schema";
import { PUBLIC_CORPUS_BOOKKEEPING_TABLES } from "@/api/lib/db/public-corpus-audit/membership";
import {
  verifyPublicCorpusCatalog,
  verifyPublicCorpusSchema,
  type PublicCorpusCatalogPosture,
} from "@/api/lib/db/public-corpus-audit/schema-verification";

const declaration = {
  purpose: "public-corpus-bookkeeping",
  schemaExport: "checkpoint",
  sqlName: "checkpoint",
  reason: "Public publisher crawl progress only",
  columns: {
    cursor: {
      kind: "corpus-cursor",
      reason:
        "Contains only a page number from a public publisher crawl and never any tenant or user identifiers",
    },
  },
};
const ownerExpression = sql`current_user = (SELECT pg_catalog.pg_get_userbyid(relowner) FROM pg_catalog.pg_class WHERE oid = 'public.checkpoint'::regclass)`;
const checkpoint = pgTable.withRLS("checkpoint", { cursor: text() }, () => [
  pgPolicy("checkpoint_owner", {
    for: "all",
    to: "public",
    using: ownerExpression,
    withCheck: ownerExpression,
  }),
]);
const ownerPolicy = {
  command: "*",
  publicOnly: true,
  permissive: true,
  using:
    "current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.checkpoint'::regclass)",
  check:
    "current_user = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.checkpoint'::regclass)",
};
const posture = {
  name: "checkpoint",
  schema: "public",
  otherRolePrivileges: false,
  rewriteRules: false,
  inheritance: false,
  accessibleViews: false,
  securityDefiners: false,
  kind: "r",
  enabled: true,
  forced: true,
  appPrivileges: false,
  userTriggers: false,
  cascadingDependents: false,
  policies: [ownerPolicy],
} satisfies PublicCorpusCatalogPosture;

describe("public corpus bookkeeping admission", () => {
  test("accepts the owner policy deparsed by PostgreSQL", async () => {
    const database = new PGlite();
    try {
      await database.exec(`CREATE TABLE public.checkpoint (cursor text);
        CREATE POLICY owner ON public.checkpoint FOR ALL TO PUBLIC
        USING (${ownerPolicy.using}) WITH CHECK (${ownerPolicy.check});`);
      const { rows } = await database.query<{ using: string; check: string }>(
        "SELECT pg_get_expr(polqual, polrelid) AS using, pg_get_expr(polwithcheck, polrelid) AS check FROM pg_policy WHERE polrelid = 'public.checkpoint'::regclass",
      );
      const expressions = rows.at(0);
      expect(expressions).toBeDefined();
      if (expressions === undefined) {
        panic("Owner policy missing from fixture catalog");
      }
      expect(expressions.using).not.toBe(ownerPolicy.using);
      expect(expressions.check).not.toBe(ownerPolicy.check);
      expect(
        verifyPublicCorpusCatalog({
          ...posture,
          policies: [{ ...ownerPolicy, ...expressions }],
        }),
      ).toEqual([]);
    } finally {
      await database.close();
    }
  });

  test("accepts operational columns with only an owner policy", () => {
    expect(
      verifyPublicCorpusSchema({ declaration, schema: { checkpoint } }),
    ).toEqual([]);
    expect(verifyPublicCorpusCatalog(posture)).toEqual([]);
  });

  test("checks every declared member against the real schema and defining module", async () => {
    const names = new Set<string>();
    const tableExports = new Map(Object.entries(schema));
    for (const entry of PUBLIC_CORPUS_BOOKKEEPING_TABLES) {
      expect(names.has(entry.sqlName)).toBe(false);
      names.add(entry.sqlName);
      expect(verifyPublicCorpusSchema({ declaration: entry, schema })).toEqual(
        [],
      );
      const module: Record<string, unknown> = await import(
        new URL(`../../../../../${entry.moduleId}.ts`, import.meta.url).href
      );
      expect(module[entry.schemaExport]).toBe(
        tableExports.get(entry.schemaExport),
      );
    }
  });

  test("rejects a missing table and a non-table export", () => {
    expect(verifyPublicCorpusSchema({ declaration, schema: {} })).toEqual([
      "missing table or non-table schema export",
    ]);
    expect(
      verifyPublicCorpusSchema({ declaration, schema: { checkpoint: {} } }),
    ).toEqual(["missing table or non-table schema export"]);
    expect(
      verifyPublicCorpusSchema({
        declaration,
        schema: {
          checkpoint: pgView("checkpoint", { cursor: text() }).existing(),
        },
      }),
    ).toEqual(["missing table or non-table schema export"]);
  });

  test("binds declaration export and SQL names to the actual table", () => {
    expect(
      verifyPublicCorpusSchema({
        declaration: { ...declaration, schemaExport: "otherExport" },
        schema: { checkpoint },
      }),
    ).toEqual(["missing table or non-table schema export"]);
    expect(
      verifyPublicCorpusSchema({
        declaration: { ...declaration, sqlName: "other_relation" },
        schema: { checkpoint },
      }),
    ).toContain("schema relation identity differs from declaration");
  });

  test("rejects nullable ownership and indirect tenant foreign keys", () => {
    const tenant = pgTable("tenant", {
      id: uuid().primaryKey(),
      organizationId: uuid("organization_id"),
    });
    const indirect = pgTable("indirect", {
      id: uuid().primaryKey(),
      parent: uuid().references(() => tenant.id),
    });
    const owned = pgTable("checkpoint", {
      cursor: text(),
      parent: uuid().references(() => indirect.id),
    });
    expect(
      verifyPublicCorpusSchema({ declaration, schema: { checkpoint: owned } }),
    ).toContain("foreign keys require a separate admission design");
    const nullable = pgTable("checkpoint", {
      cursor: text(),
      workspaceId: uuid("workspace_id"),
    });
    expect(
      verifyPublicCorpusSchema({
        declaration,
        schema: { checkpoint: nullable },
      }),
    ).toContain("reviewed columns must exactly match schema columns");
  });

  test("new columns require review and source content cannot enter", () => {
    const added = pgTable("checkpoint", { cursor: text(), content: text() });
    expect(
      verifyPublicCorpusSchema({ declaration, schema: { checkpoint: added } }),
    ).toContain("reviewed columns must exactly match schema columns");
    expect(
      verifyPublicCorpusSchema({
        declaration: {
          ...declaration,
          columns: {
            ...declaration.columns,
            content: {
              kind: "source-content",
              reason:
                "This is source document full text with an explicitly unsupported data classification for a corpus bookkeeping table",
            },
          },
        },
        schema: { checkpoint: added },
      }),
    ).toContain("column classification does not match its schema type");
  });

  test("a policy named owner that admits PUBLIC is rejected", () => {
    const permissive = pgTable.withRLS("checkpoint", { cursor: text() }, () => [
      pgPolicy("checkpoint_owner", {
        for: "all",
        to: "public",
        using: sql`true`,
        withCheck: sql`true`,
      }),
    ]);
    expect(
      verifyPublicCorpusSchema({
        declaration,
        schema: { checkpoint: permissive },
      }),
    ).toContain("schema policy must exclusively admit the table owner");
  });

  test("generic maintenance state remains ineligible", () => {
    expect(
      verifyPublicCorpusSchema({
        declaration: {
          schemaExport: "databaseBackfillStates",
          sqlName: "database_backfill_states",
          purpose: "generic-maintenance",
          reason: "generic maintenance state incl. tenant repairs",
          columns: {},
        },
        schema,
      }),
    ).toContain("generic maintenance state incl. tenant repairs");
  });

  test("all schema and policy boundaries are checked", () => {
    const policy = {
      for: "all",
      to: "public",
      using: ownerExpression,
      withCheck: ownerExpression,
    } as const;
    const tables = [
      pgTable("checkpoint", { cursor: text() }),
      pgTable.withRLS("checkpoint", { cursor: text() }, () => [
        pgPolicy("owner", { ...policy, for: "select" }),
      ]),
      pgTable.withRLS("checkpoint", { cursor: text() }, () => [
        pgPolicy("owner", { ...policy, as: "restrictive" }),
      ]),
      pgTable.withRLS("checkpoint", { cursor: text() }, () => [
        pgPolicy("owner", { ...policy, to: "stella" }),
      ]),
      pgTable.withRLS("checkpoint", { cursor: text() }, () => [
        pgPolicy("owner1", policy),
        pgPolicy("owner2", policy),
      ]),
      pgSchema("private").table("checkpoint", { cursor: text() }),
      pgTable("different", { cursor: text() }),
    ];
    for (const candidate of tables) {
      expect(
        verifyPublicCorpusSchema({
          declaration,
          schema: { checkpoint: candidate },
        }).length,
      ).toBeGreaterThan(0);
    }
    const dependent = pgTable("dependent", {
      parent: text().references(() => checkpoint.cursor, {
        onUpdate: "cascade",
      }),
    });
    expect(
      verifyPublicCorpusSchema({
        declaration,
        schema: { checkpoint, dependent },
      }),
    ).toContain("incoming foreign key can mutate dependent rows");
  });

  test("bookkeeping cannot cascade into dependent rows", () => {
    const dependent = pgTable("dependent", {
      parent: text().references(() => checkpoint.cursor, {
        onDelete: "cascade",
      }),
    });
    expect(
      verifyPublicCorpusSchema({
        declaration,
        schema: { checkpoint, dependent },
      }),
    ).toContain("incoming foreign key can mutate dependent rows");
  });

  test.each([
    { ...posture, otherRolePrivileges: true },
    { ...posture, rewriteRules: true },
    { ...posture, inheritance: true },
    { ...posture, accessibleViews: true },
    { ...posture, securityDefiners: true },
    { ...posture, forced: false },
    { ...posture, appPrivileges: true },
    { ...posture, kind: "v" },
    { ...posture, kind: "p" },
    { ...posture, userTriggers: true },
    { ...posture, cascadingDependents: true },
    {
      ...posture,
      policies: [{ ...ownerPolicy, using: "true", check: "true" }],
    },
    { ...posture, policies: [...posture.policies, ...posture.policies] },
  ])("rejects an unsafe migrated posture %#", (unsafe) => {
    expect(verifyPublicCorpusCatalog(unsafe).length).toBeGreaterThan(0);
  });

  test("rejects missing migrated tables", () => {
    expect(verifyPublicCorpusCatalog(undefined)).toEqual([
      "table missing from migrated catalog",
    ]);
  });
});
