import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import { SOURCE_ABSENT_TEXT_COMPARISONS } from "@/api/handlers/case-law/ingestion/adapters/absent-source-text";
import { PUBLISHER_SUMMARY_SOURCES } from "@/api/lib/case-law/publisher-summary";

/**
 * The reading behind `repair-publisher-absent-text.ts`, apart from the script
 * so it can be run against a database in a test.
 *
 * Both the keys the repair looks at and the sentences it recognises are
 * derived, never listed here: the keys come from the publisher-summary source
 * list the read path itself walks, the sentences from the adapters' own
 * declarations. A source that starts printing a new sentence, or a
 * jurisdiction whose summary key is added to the read path, is covered by this
 * repair without anybody remembering to extend it.
 */

/**
 * The metadata keys a publisher's own prose is read from. List-shaped sources
 * are left out on purpose: a marker is a sentence a source prints in place of
 * prose, and none is observed inside a keyword list.
 */
const PUBLISHER_TEXT_METADATA_KEYS: readonly string[] =
  PUBLISHER_SUMMARY_SOURCES.flatMap((source) =>
    source.origin === "metadata" && source.shape === "text" ? [source.key] : [],
  );

const textArray = (values: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

/**
 * The publisher-summary keys of one row whose value is a declared marker.
 *
 * `btrim(regexp_replace(…))` is `absentTextComparison` in SQL, and the database
 * test holds the two readings to the same answer over the same stored values.
 * `->>` renders a non-string value as text where the TypeScript reading skips
 * it, which changes nothing here: no number or array renders as one of the
 * sentences.
 */
const ABSENT_PUBLISHER_TEXT_KEYS = sql`(
  SELECT coalesce(array_agg(candidate.key), ARRAY[]::text[])
    FROM unnest(${textArray(PUBLISHER_TEXT_METADATA_KEYS)}) AS candidate(key)
   WHERE btrim(
           regexp_replace(
             ${caseLawDecisions.metadata} ->> candidate.key,
             '\\s+',
             ' ',
             'g'
           )
         ) = ANY(${textArray(SOURCE_ABSENT_TEXT_COMPARISONS)})
)`;

/**
 * A row still carrying a marker.
 *
 * Self-consuming: a repaired row no longer matches, so a walk over batches
 * converges on an empty selection and needs no cursor, and a re-check at write
 * time leaves a decision the crawl re-observed in between exactly as the crawl
 * wrote it.
 */
export const carriesAbsentPublisherText: SQL = sql`cardinality(${ABSENT_PUBLISHER_TEXT_KEYS}) > 0`;

/**
 * The row's metadata with the marker keys removed.
 *
 * Removed rather than emptied, because that is what the fixed adapter now
 * writes: a field the source printed a marker in is a field the publisher did
 * not fill, and the read path resolves an absent key to the next source in its
 * list. Nothing else in the object is touched, and the stored raw payload is
 * untouched entirely, so the sentence stays recoverable from what the
 * publisher actually served.
 */
export const strippedPublisherMetadata: SQL<Record<string, unknown>> =
  sql`${caseLawDecisions.metadata} - ${ABSENT_PUBLISHER_TEXT_KEYS}`;
