import { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text } from "drizzle-orm/pg-core";

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

  test("rejects a missing schema entry", () => {
    expect(verifyPublicCorpusSchema({ declaration, schema: {} })).toEqual([
      "missing table or non-table schema export",
    ]);
  });
  test("checks the declared relation identity", () => {
    expect(
      verifyPublicCorpusSchema({
        declaration: { ...declaration, sqlName: "other_relation" },
        schema: { checkpoint },
      }),
    ).toContain("schema relation identity differs from declaration");
  });
  test("checks the declared columns", () => {
    const changed = pgTable("checkpoint", { cursor: text(), label: text() });
    expect(
      verifyPublicCorpusSchema({
        declaration,
        schema: { checkpoint: changed },
      }),
    ).toContain("reviewed columns must exactly match schema columns");
  });
  test("rejects a missing catalog entry", () => {
    expect(verifyPublicCorpusCatalog(undefined)).toEqual([
      "table missing from migrated catalog",
    ]);
  });
});
