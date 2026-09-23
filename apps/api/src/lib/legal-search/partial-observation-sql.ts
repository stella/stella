/**
 * The quality marker the ingestion pipeline persists with a partial source
 * observation, and the SQL that reads it.
 *
 * A leaf module, importing nothing of the API, because the database schema
 * declares an index on this predicate and the readers apply it: both sides
 * have to be the same text, and a schema that imported the pipeline would
 * import the schema back.
 */
import type { Column, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";

/** Pipeline-owned quality marker persisted with partial source observations. */
export const PARTIAL_OBSERVATION_KEY = "_stellaPartialObservation";

export type PartialObservation = {
  caseNumberIsPlaceholder: boolean;
  isListingOnly: boolean;
};

/**
 * The marker's own field names, spelled once. Every reader and the SQL
 * predicates below address the same stored path, and a literal repeated in
 * each would be free to drift: a query looking under a key the pipeline
 * stopped writing answers `false` for every row and says nothing about it.
 */
export const PARTIAL_OBSERVATION_FIELD = {
  CASE_NUMBER_IS_PLACEHOLDER: "caseNumberIsPlaceholder",
  IS_LISTING_ONLY: "isListingOnly",
} as const satisfies Record<string, keyof PartialObservation>;

/**
 * Rows this reader would answer `isListingOnly: false` for, as a predicate
 * over a decision's metadata column.
 *
 * The marker lives inside the metadata blob rather than in a column of its
 * own, so this is a JSONB path extraction. Written as
 * `jsonb_extract_path_text` rather than `-> ... ->>` because `jsonb ->
 * unknown` does not resolve — the function's variadic `text[]` does.
 *
 * `IS DISTINCT FROM` rather than `<>`: the marker is written only when it is
 * true, so almost every row has no such key and the extraction yields NULL.
 * A row with no marker is a row that carries detail.
 *
 * The path is inlined rather than bound: this predicate is the definition of
 * `case_law_decisions_search_candidate_idx`, and PostgreSQL can only match a
 * query against a partial index's predicate once both are constants. A bound
 * path folds to a constant under a custom plan and stays a parameter under a
 * generic one, which would silently drop the search's candidate read back to
 * a heap fetch per candidate. The values are code constants, never input.
 */
export const storedObservationHasDetail = (metadata: Column): SQL =>
  sql`jsonb_extract_path_text(${metadata}, ${sql.raw(`'${PARTIAL_OBSERVATION_KEY}'`)}, ${sql.raw(`'${PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY}'`)}) is distinct from 'true'`;

/**
 * The stored metadata with the listing-only marker set, as a SQL value.
 *
 * For a write that decides the marker with the row's own state in its WHERE:
 * "this row holds no document" is only true at the instant of the write, so
 * the marker that says so is set by the same statement. Other marker fields
 * already stored are kept; a stored marker that is not an object is replaced,
 * since `||` would otherwise build an array the predicate cannot read.
 */
export const metadataMarkedListingOnly = (metadata: Column | SQL): SQL =>
  sql`jsonb_set(coalesce(${metadata}, '{}'::jsonb), ${sql.raw(`'{${PARTIAL_OBSERVATION_KEY}}'`)}, (case when jsonb_typeof(${metadata} -> ${sql.raw(`'${PARTIAL_OBSERVATION_KEY}'`)}) = 'object' then ${metadata} -> ${sql.raw(`'${PARTIAL_OBSERVATION_KEY}'`)} else '{}'::jsonb end) || jsonb_build_object(${sql.raw(`'${PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY}'`)}, true))`;

/**
 * The same predicate as raw SQL, for the lateral joins that address the
 * decision table under an alias and never see a Drizzle column.
 *
 * `metadataColumn` is a code constant (`"d.metadata"`), never request input.
 */
export const storedObservationHasDetailSqlFor = (
  metadataColumn: string,
): string =>
  `jsonb_extract_path_text(${metadataColumn}, '${PARTIAL_OBSERVATION_KEY}', '${PARTIAL_OBSERVATION_FIELD.IS_LISTING_ONLY}') is distinct from 'true'`;
