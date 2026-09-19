import { sql } from "drizzle-orm";

import { LIMITS } from "@/api/lib/limits";

type CorpusSearchVectorOptions = {
  regconfig: string;
  searchableText: string;
  title: string | null;
  useUnaccent: boolean;
};

/**
 * The `tsv` expression for a corpus projection row: the document's title and
 * searchable text, normalized for the row's FTS configuration and bounded to
 * what one tsvector can hold.
 *
 * Postgres builds a tsvector's lexeme buffer against a fixed ceiling
 * (`MAXSTRPOS`) and raises SQLSTATE 54000 from `make_tsvector` above it, so an
 * unbounded document text makes the upsert a statement that cannot succeed:
 * the row never lands, the backfill probe reads it back as missing, and the
 * next pass fails on it identically. Bounding the input keeps the statement
 * writable for every document, at the cost of the tail beyond the bound not
 * being searchable.
 *
 * `left(...)` wraps the normalization rather than the raw columns: unaccenting
 * expands some characters into several, so only a bound taken over the text
 * `to_tsvector` actually reads holds.
 */
export const corpusSearchVector = ({
  regconfig,
  searchableText,
  title,
  useUnaccent,
}: CorpusSearchVectorOptions) => {
  const normalized = sql`arabic_normalize(coalesce(${title}, '') || ' ' || coalesce(${searchableText}, ''))`;
  const folded = useUnaccent ? sql`unaccent(${normalized})` : normalized;
  return sql`to_tsvector(${regconfig}, left(${folded}, ${LIMITS.corpusSearchVectorMaxChars}::int))`;
};
