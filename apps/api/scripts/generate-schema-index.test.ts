import { expect, test } from "bun:test";

import { indexSchemaSource, renderSchemaIndex } from "./generate-schema-index";

const SOURCE = `
import * as p from "drizzle-orm/pg-core";

/**
 * Conversations a user holds. Each belongs to one organization.
 */
export const threads = p.pgTable(
  "chat_threads",
  {
    id: pUuid<"chatThread">().primaryKey(),
    // The matter it lives under. Null for a global chat.
    workspaceId: safeWorkspaceId("workspace_id").references(() => w.id),
    title: p.varchar({ length: 255 }).notNull(),
    /**
     * Matters the chat draws context from. Empty means none pinned.
     */
    contextMatterIds: safeWorkspaceId("context_matter_ids")
      .array()
      .notNull()
      .default([]),
    ...retryColumns(),
  },
  (table) => [...threadPolicies()],
);

export const locks = p.pgTable.withRLS("locks", {
  key: p.text().primaryKey(),
});

export const notATable = { id: 1 };
const unexported = p.pgTable("hidden", { id: p.text() });
`;

const tables = indexSchemaSource({ fileName: "chat.ts", source: SOURCE });

test("indexes each exported table with its SQL name, export, line and summary", () => {
  expect(
    tables.map(({ exportName, line, rls, sqlName, summary }) => ({
      exportName,
      line,
      rls,
      sqlName,
      summary,
    })),
  ).toEqual([
    {
      exportName: "threads",
      line: 7,
      rls: true,
      sqlName: "chat_threads",
      summary: "Conversations a user holds.",
    },
    {
      exportName: "locks",
      line: 26,
      rls: true,
      sqlName: "locks",
      summary: "",
    },
  ]);
});

test("a table enabling RLS through its own chain is indexed as RLS", () => {
  const indexed = indexSchemaSource({
    fileName: "audit.ts",
    source: `
export const audited = p.pgTable("audited", { id: p.text() }).enableRLS();
export const plain = p.pgTable("plain", { id: p.text() });
`,
  });
  expect(indexed.map(({ rls, sqlName }) => ({ rls, sqlName }))).toEqual([
    { rls: true, sqlName: "audited" },
    { rls: false, sqlName: "plain" },
  ]);
});

test("reads a column's SQL name, builder and flags from its builder chain", () => {
  expect(tables.at(0)?.columns).toEqual([
    {
      builder: "pUuid",
      flags: ["pk", "not null"],
      key: "id",
      line: 10,
      sqlName: "id",
      summary: "",
    },
    {
      builder: "safeWorkspaceId",
      flags: ["fk", "null"],
      key: "workspaceId",
      line: 12,
      sqlName: "workspace_id",
      summary: "The matter it lives under.",
    },
    {
      builder: "varchar",
      flags: ["not null"],
      key: "title",
      line: 13,
      sqlName: "title",
      summary: "",
    },
    {
      builder: "safeWorkspaceId",
      flags: ["array", "default", "not null"],
      key: "contextMatterIds",
      line: 17,
      sqlName: "context_matter_ids",
      summary: "Matters the chat draws context from.",
    },
    {
      builder: "spread",
      flags: [],
      key: "{...retryColumns()}",
      line: 21,
      sqlName: "{...retryColumns()}",
      summary: "",
    },
  ]);
});

test("cuts a long summary to one bounded line", () => {
  const long = `export const t = p.pgTable("t", {
    /** ${"word ".repeat(80)}*/
    c: p.text(),
  });`;
  const summary = indexSchemaSource({ fileName: "t.ts", source: long })
    .at(0)
    ?.columns.at(0)?.summary;

  expect(summary?.length).toBe(160);
  expect(summary?.endsWith("…")).toBe(true);
});

test("renders one grep-able line per column under a heading per table", () => {
  const rendered = renderSchemaIndex("db/schema/chat.ts", tables) ?? "";

  expect(rendered).toContain("## chat_threads · `threads` · chat.ts:7 · rls");
  expect(rendered).toMatch(
    /^chat_threads\.workspace_id +safeWorkspaceId +fk,null +chat\.ts:12 +The matter it lives under\.$/mu,
  );
  expect(rendered).toMatch(/^locks\.key +text +pk,not null +chat\.ts:27$/mu);
});

test("a module without tables has no index", () => {
  expect(renderSchemaIndex("db/schema/common.ts", [])).toBeNull();
});

test("an abbreviation does not end a summary", () => {
  const source = `export const t = p.pgTable("t", {
    /** Labels per kind (e.g. contract or memo), i.e. a taxonomy. Shown in filters. */
    c: p.text(),
  });`;

  expect(
    indexSchemaSource({ fileName: "t.ts", source }).at(0)?.columns.at(0)
      ?.summary,
  ).toBe("Labels per kind (e.g. contract or memo), i.e. a taxonomy.");
});

test("an identity column is generated and never null; a computed one may be", () => {
  const source = `export const t = p.pgTable("t", {
    id: p.integer().generatedAlwaysAsIdentity(),
    seq: p.bigint({ mode: "number" }).generatedByDefaultAsIdentity(),
    total: p.integer().generatedAlwaysAs(sql\`1\`),
  });`;

  expect(
    indexSchemaSource({ fileName: "t.ts", source })
      .at(0)
      ?.columns.map(({ flags, key }) => ({ flags, key })),
  ).toEqual([
    { flags: ["generated", "not null"], key: "id" },
    { flags: ["generated", "not null"], key: "seq" },
    { flags: ["generated", "null"], key: "total" },
  ]);
});
