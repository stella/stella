import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, pgView, text, uuid } from "drizzle-orm/pg-core";

import * as schema from "@/api/db/schema";

import { PUBLIC_CORPUS_BOOKKEEPING_TABLES } from "../../../../../.oxlint-plugins/audit-on-mutation/public-corpus-bookkeeping.ts";
import {
  verifyPublicCorpusCatalog,
  verifyPublicCorpusSchema,
  type PublicCorpusCatalogPosture,
} from "../../../../../scripts/public-corpus-bookkeeping-verification.ts";

const declaration = {
  schemaExport: "checkpoint",
  sqlName: "checkpoint",
  reason: "Public publisher crawl progress only",
  columns: { cursor: "Next public publisher page number" },
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
  kind: "r",
  enabled: true,
  forced: true,
  appPrivileges: false,
  userTriggers: false,
  cascadingDependents: false,
  policies: [ownerPolicy],
} satisfies PublicCorpusCatalogPosture;

describe("public corpus bookkeeping admission", () => {
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
    ).toContain("tenant or accountable-user ownership column/foreign key");
    const nullable = pgTable("checkpoint", {
      cursor: text(),
      workspaceId: uuid("workspace_id"),
    });
    expect(
      verifyPublicCorpusSchema({
        declaration,
        schema: { checkpoint: nullable },
      }),
    ).toContain("tenant or accountable-user ownership column/foreign key");
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
            content: "Reviewed source document full text",
          },
        },
        schema: { checkpoint: added },
      }),
    ).toContain("content-bearing column is not bookkeeping");
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
