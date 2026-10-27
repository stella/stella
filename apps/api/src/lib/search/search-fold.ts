import { sql } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";

/**
 * Text as a reader types it into a find: lower-case, accents folded by the
 * `unaccent` dictionary. Migration `20261026210000_search_fold` owns the SQL
 * function; trigram indexes are built over this exact call, so a query that
 * spells the fold any other way cannot use them. `foldLikePostgresSearch` in
 * `@stll/text-normalize` is the client half, held to it by
 * `postgres-search-fold-parity.db.test.ts`.
 */
export const searchFold = (value: SQLWrapper | string) =>
  sql<string>`search_fold(${value})`;
