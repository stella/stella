import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

// The passive fixture sits inside the case-law boundary. These cases cover
// the other ways a file reads public law, which the fixture cannot also be:
// through the legislation handle, through the shared-query registry, as an
// owner module itself, and not at all.

const RELATION_SQL = [
  "declare const sql: (parts: TemplateStringsArray) => unknown;",
  "export const hits = sql`select 1 from legislation_index_jobs`;",
  "export const allowed = sql`select 1 from legislation_search_documents`;",
].join("\n");

const lint = async (source: string, sourcePath = "apps/api/src/lib/read.ts") =>
  await lintSingleRule("public-case-law-db-boundary", `${source}\n`, {
    sourcePath,
  });

describe.serial("public-law relation scan", () => {
  test("covers a legislation read", async () => {
    const source = [
      'import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";',
      "export type Handle = LegislationReadDb;",
      RELATION_SQL,
    ].join("\n");

    expect(await lint(source)).toEqual([4]);
  });

  test("covers a module that registers a shared query", async () => {
    const source = [
      'import { PUBLIC_LAW_SHARED_QUERY } from "@/api/lib/public-law-shared-query";',
      "export const key = PUBLIC_LAW_SHARED_QUERY;",
      RELATION_SQL,
    ].join("\n");

    expect(await lint(source)).toEqual([4]);
  });

  test("covers the connection module itself", async () => {
    expect(
      await lint(RELATION_SQL, "apps/api/src/lib/public-law-read-db.ts"),
    ).toEqual([2]);
  });

  test("leaves a file that reads no public law alone", async () => {
    expect(await lint(RELATION_SQL)).toEqual([]);
  });

  test("keeps the case-law import and text checks to case-law reads", async () => {
    const source = [
      'import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";',
      'import { legislationTitleFold } from "@/api/db/schema";',
      "export type Handle = LegislationReadDb;",
      'export const audience = "workspace";',
      "void legislationTitleFold;",
    ].join("\n");

    expect(await lint(source)).toEqual([]);
  });
});
