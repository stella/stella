import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { legislationSources } from "@/api/db/schema";
import { buildListStatutesQuery } from "@/api/handlers/legislation/list";
import { createSafeId } from "@/api/lib/branded-types";
import type { LegislationReadTransaction } from "@/api/lib/legislation-public-read-db";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

/**
 * The statute list matches a typed title through `legislation_title_fold`,
 * whose `unaccent` maps full-width `％` to `%`. The term is escaped after the
 * fold, so a full-width percent stays a literal; escaped before it, it would
 * turn into a wildcard and match `50x`. Only the real extension folds it,
 * hence PostgreSQL rather than PGlite.
 */

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const TABLES = [
  "legislation_sources",
  "legislation_documents",
  "case_law_statute_citation_count_state",
  "case_law_statute_citation_counts",
  "case_law_sources",
] as const;
const TITLES = [
  "Zákon o ５０％ slevě",
  "Zákon o 50% slevě",
  "Zákon o 50x slevě",
] as const;

describe.skipIf(!enabled)("statute list title search (postgres)", () => {
  test("a full-width percent in the query matches only itself", async () => {
    const databaseUrl =
      process.env["DATABASE_URL"] ??
      panic("The enabled PostgreSQL test requires DATABASE_URL");
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const schemaName = `list_title_fold_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      const schema = sql.identifier(schemaName);
      await db.execute(sql`CREATE SCHEMA ${schema}`);
      try {
        for (const table of TABLES) {
          await db.execute(sql`CREATE TABLE ${schema}.${sql.identifier(table)}
            (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
        }
        await db.execute(sql`SET search_path TO ${schema}, public`);
        const sourceId = createSafeId<"legislationSource">();
        await db.insert(legislationSources).values({
          id: sourceId,
          adapterKey: `list-title-fold-${sourceId}`,
          name: "List title fold fixture",
        });
        await db.execute(sql`INSERT INTO legislation_documents
          (id, source_id, eli, title, country, language, version_valid_from)
          SELECT gen_random_uuid(), ${sourceId}::uuid,
            '/eli/cz/sb/2000/' || input.position, input.title, 'CZE', 'cs',
            DATE '2010-01-01'
          FROM unnest(ARRAY[${sql.join(
            TITLES.map((title) => sql`${title}`),
            sql`, `,
          )}]::text[]) WITH ORDINALITY AS input(title, position)`);

        for (const query of ["50%", "50％", "５０％"]) {
          const rows = await buildListStatutesQuery(
            asTestRaw<LegislationReadTransaction>(db),
            {
              country: "CZE",
              query: { language: "cs", query },
              limit: 10,
              cursor: null,
              asOf: sql`DATE '2020-01-01'`,
            },
          );

          expect(rows.map(({ title }) => title).toSorted()).toEqual(
            ["Zákon o ５０％ slevě", "Zákon o 50% slevě"].toSorted(),
          );
        }
      } finally {
        await db.execute(sql`SET search_path TO public`);
        await db.execute(sql`DROP SCHEMA ${schema} CASCADE`);
      }
    });
  });
});
