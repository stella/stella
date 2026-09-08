import { panic } from "better-result";
import { type SQL, type SQLWrapper, sql } from "drizzle-orm";

import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";

/**
 * The physical index a manifest routes a jurisdiction to, as a SQL expression
 * over the row's jurisdiction column: the SQL twin of
 * `corpusIndexIdFromManifest`.
 *
 * The projection writer derives `desired_index_id` from the manifest route,
 * and a read path deciding whether a generation holds a row compares against
 * that column, so the comparison has to move with the manifest instead of
 * restating a routing rule of its own. Both renderings switch on the same
 * `route` value and are exhaustive over it, so a new route type stops
 * compiling in both, and `corpus-index-route-sql.db.test.ts` proves the two
 * agree executably for every declared manifest.
 *
 * Constants are inlined with `sql.raw`: they come from the manifest, never
 * from input.
 */
export const corpusIndexIdSqlFromManifest = (
  manifest: CorpusIndexManifest,
  jurisdiction: SQLWrapper,
): SQL => {
  const generation = sql.raw(`'${manifest.generation}'`);
  switch (manifest.route.type) {
    case "case_law_group": {
      const groupArms = sql.join(
        Object.entries(manifest.route.byJurisdiction).map(
          ([country, group]) =>
            sql`WHEN ${sql.raw(`'${country}'`)} THEN ${sql.raw(`'${group}'`)}`,
        ),
        sql`
    `,
      );
      return sql`${generation} || '_' || CASE upper(${jurisdiction})
    ${groupArms}
    ELSE lower(${jurisdiction})
  END`;
    }
    case "jurisdiction":
      return sql`${generation} || '_' || lower(${jurisdiction})`;
    default:
      manifest.route satisfies never;
      return panic(`Unhandled route: ${String(manifest.route)}`);
  }
};
