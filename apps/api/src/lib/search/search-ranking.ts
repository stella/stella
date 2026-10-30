import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { SearchRankingTier } from "./pagination";
import { buildPlainSearchTsQuery } from "./query";

// File extensions a query typed as a filename may end with; matched against
// the lower-cased, unaccented query.
const FILENAME_EXTENSION_PATTERN =
  "\\.(pdf|docx?|dotx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|md|csv|html?|eml|msg|jpe?g|png|gif|tiff?|zip)$";

const SEARCH_TIER = {
  FILTER_ONLY: 0,
  LOOSE: 1,
  ALL_TITLE_TOKENS: 2,
  TITLE_PREFIX: 3,
  EXACT_TITLE: 4,
} as const satisfies Record<string, SearchRankingTier>;

export const searchTitleTierSql = (title: SQL, query: string): SQL => {
  if (query.trim() === "") {
    return sql`${SEARCH_TIER.FILTER_ONLY}::int`;
  }
  const titleTsQuery = buildPlainSearchTsQuery(query);
  const foldedTitle = sql`lower(unaccent(arabic_normalize(${title})))`;
  const foldedQuery = sql`lower(unaccent(arabic_normalize(${query.trim()})))`;
  // Only a recognised file extension is dropped, so a query typed as a
  // filename still prefixes its title while dotted legal references such as
  // "Article 1.2" stay whole.
  const foldedQueryStem = sql`regexp_replace(${foldedQuery}, ${FILENAME_EXTENSION_PATTERN}, '')`;
  return sql`CASE
      WHEN ${foldedTitle} = ${foldedQuery} THEN ${SEARCH_TIER.EXACT_TITLE}::int
      WHEN starts_with(${foldedTitle}, ${foldedQueryStem}) THEN ${SEARCH_TIER.TITLE_PREFIX}::int
      WHEN to_tsvector('simple', unaccent(arabic_normalize(${title}))) @@ ${titleTsQuery}
        THEN ${SEARCH_TIER.ALL_TITLE_TOKENS}::int
      ELSE ${SEARCH_TIER.LOOSE}::int
    END`;
};
