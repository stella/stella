/**
 * One definition of "this decision holds a document", shared by
 * everything that has to decide whether a payload is safe to overwrite,
 * safe to drop, or still worth fetching.
 *
 * The question is asked in three places that must agree — the ingestion
 * refresh, the deferred-document queue, and the column trim — and each
 * of them destroys or re-fetches a document when it gets the answer
 * wrong. It is answered without reading the payload: the text can be
 * megabytes, and two of the three callers ask it inside a loop.
 */

import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/handlers/case-law/corpus-storage";

/**
 * A jsonb array's length, or 0 for anything that is not an array.
 * `jsonb_array_length` raises on a non-array, and these columns hold
 * `{}` (the empty-AST placeholder) as often as they hold a document.
 */
const jsonbArrayLength = (column: SQL | typeof caseLawDecisions.sections) =>
  sql`coalesce(jsonb_array_length(case when jsonb_typeof(${column}) = 'array' then ${column} else '[]'::jsonb end), 0)`;

/**
 * Whether the row's own Postgres columns hold a document.
 *
 * An empty string is the "fetched, and the source had nothing" marker
 * rather than a document, and `{}` is the placeholder an adapter without
 * a parser emits, so neither counts.
 */
export const pgPayloadCarriesDocument: SQL<boolean> = sql<boolean>`(
  coalesce(${caseLawDecisions.fulltext}, '') <> ''
  or ${jsonbArrayLength(sql`${caseLawDecisions.documentAst} -> 'blocks'`)} > 0
  or ${jsonbArrayLength(caseLawDecisions.sections)} > 0
)`;

/**
 * Whether a content hash names the payload a metadata-first ingest
 * writes before the document exists. Such objects are present, keyed and
 * readable, and hold nothing — so their existence proves only that the
 * corpus was written to, never that it holds a document.
 */
export const namesEmptyCorpusPayload = (contentHash: string | null): boolean =>
  contentHash !== null && EMPTY_CORPUS_CONTENT_HASHES.includes(contentHash);

/**
 * Whether object storage holds a document for this row: it has been
 * written to, and what it holds is not one of the empty shapes.
 */
export const corpusCarriesDocument = (contentHash: string | null): boolean =>
  contentHash !== null && !namesEmptyCorpusPayload(contentHash);
