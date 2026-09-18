import { panic } from "better-result";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

import { caseLawIndexIdSql } from "@/api/lib/legal-search/case-law-index-groups";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";

/**
 * The physical index a manifest routes a jurisdiction to, as a SQL expression
 * over the row's jurisdiction column: the SQL twin of
 * `corpusIndexIdFromManifest`.
 *
 * The projection writer derives `desired_index_id` from the manifest route,
 * and a read path deciding whether a generation holds a row compares against
 * that column, so the comparison has to move with the manifest instead of
 * restating a routing rule of its own. Both renderings dispatch on the same
 * `route` value and are exhaustive over it, so a new route type stops
 * compiling in both; the case-law arm then defers to `caseLawIndexIdSql`, the
 * same fragment the projection trigger's `case_law_corpus_index_id` function
 * is built from, so the three renderings of the group declaration are one.
 * `corpus-index-route-sql.db.test.ts` proves this and the TypeScript side
 * agree executably for every declared manifest and jurisdiction.
 *
 * The generation is inlined with `sql.raw`: it comes from the manifest, never
 * from input.
 */
export const corpusIndexIdSqlFromManifest = (
  manifest: CorpusIndexManifest,
  jurisdiction: SQLWrapper,
): SQL => {
  const generation = sql.raw(`'${manifest.generation}'`);
  switch (manifest.route.type) {
    case "case_law_group":
      return caseLawIndexIdSql(generation, jurisdiction);
    case "jurisdiction":
      return sql`${generation} || '_' || lower(${jurisdiction})`;
    default:
      manifest.route satisfies never;
      return panic(`Unhandled route: ${String(manifest.route)}`);
  }
};
