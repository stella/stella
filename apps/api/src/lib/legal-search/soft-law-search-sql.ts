import { type AnyColumn, sql } from "drizzle-orm";

/** Bounds every tsvector under PostgreSQL's size limit; text past it is not searched. */
const SOFT_LAW_SEARCH_TEXT_CHARS = 200_000;

/**
 * The expressions behind the search indexes, spelled the way PostgreSQL
 * stores them, so the schema's index and the query planner agree.
 */
export const softLawTitleVector = (title: AnyColumn) =>
  sql`to_tsvector('simple'::regconfig, search_fold(${title}))`;

export const softLawBodyVector = (extractedText: AnyColumn) =>
  sql`to_tsvector('simple'::regconfig, search_fold(left(${extractedText}, ${sql.raw(String(SOFT_LAW_SEARCH_TEXT_CHARS))})))`;
