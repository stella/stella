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
  test("case-law reads keep publication conditions in the owner", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { sql } from "drizzle-orm";',
      "export const read = sql`select d.id from case_law_decisions d where d.redacted_at is null`;",
      "void caseLawPublicReadDb;",
    ].join("\n");
    expect(
      await lint(source, "apps/api/src/handlers/case-law/read.ts"),
    ).toContain(3);
  });

  test("case-law filters keep redaction and observation conditions in the owner", async () => {
    const redactionSource = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { caseLawDecisions } from "@/api/db/schema";',
      'import { isNull } from "drizzle-orm";',
      "const query = caseLawPublicReadDb((tx) => tx.select().from(caseLawDecisions).where(isNull(caseLawDecisions.redactedAt)));",
    ].join("\n");
    expect(
      await lint(redactionSource, "apps/api/src/handlers/case-law/read.ts"),
    ).toContain(4);

    const observationSource = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { storedObservationHasDetail } from "@/api/lib/legal-search/partial-observation-sql";',
      "void caseLawPublicReadDb;",
      "void storedObservationHasDetail;",
    ].join("\n");
    expect(
      await lint(observationSource, "apps/api/src/handlers/case-law/read.ts"),
    ).toContain(2);
  });

  test("query-builder conditions use the publication owner", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { caseLawDecisions } from "@/api/db/schema";',
      'import { sql } from "drizzle-orm";',
      `const query = caseLawPublicReadDb((tx) => tx.select().from(caseLawDecisions).where(sql\`\${caseLawDecisions.redactedAt} IS NULL\`));`,
    ].join("\n");
    expect(
      await lint(source, "apps/api/src/handlers/case-law/read.ts"),
    ).toContain(4);
  });

  test("display state is independent of the publication filter", async () => {
    const source = [
      'import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";',
      'import { caseLawDecisions } from "@/api/db/schema";',
      'import { isNull } from "drizzle-orm";',
      "const query = caseLawPublicReadDb((tx) => tx.select({ redacted: isNull(caseLawDecisions.redactedAt) }).from(caseLawDecisions));",
    ].join("\n");
    expect(
      await lint(source, "apps/api/src/handlers/case-law/read.ts"),
    ).toEqual([]);
  });

  test("the publication owner may define the publication condition", async () => {
    const source = "export const clause = sql`d.redacted_at IS NULL`;";
    expect(
      await lint(
        source,
        "apps/api/src/lib/case-law/published-decisions-sql.ts",
      ),
    ).toEqual([]);
  });

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
