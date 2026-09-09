import { panic } from "better-result";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { PUBLISHER_SUMMARY_SOURCES } from "@/api/lib/case-law/publisher-summary";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

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
 *
 * Every reading below takes the markers of one adapter, because a marker is
 * only absence for the source that prints it: stripping a sentence from a
 * source whose adapter does not read it would be undone by the next crawl.
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

const PUBLISHER_TEXT_KEYS_SQL = textArray(PUBLISHER_TEXT_METADATA_KEYS);

/**
 * The publisher-summary keys of one row whose value is one of the given
 * markers, as an expression over a metadata column named by the caller.
 *
 * `btrim(regexp_replace(…))` is `absentTextComparison` in SQL, and the database
 * test holds the two readings to the same answer over the same stored values.
 * `->>` renders a non-string value as text where the TypeScript reading skips
 * it, which changes nothing here: no number or array renders as one of the
 * sentences.
 */
const absentPublisherTextKeys = (
  metadata: SQL,
  markers: readonly string[],
): SQL => sql`(
  SELECT coalesce(array_agg(candidate.key), ARRAY[]::text[])
    FROM unnest(${PUBLISHER_TEXT_KEYS_SQL}) AS candidate(key)
   WHERE btrim(
           regexp_replace(${metadata} ->> candidate.key, '\\s+', ' ', 'g')
         ) = ANY(${textArray(markers)})
)`;

/** Where a walk of one source stands: the last row a page examined. */
export type AbsentTextCursor = {
  /** The row's `created_at`, the leading key of the index the walk uses. */
  createdAt: string;
  id: SafeId<"caseLawDecision">;
};

/** What one page of the walk examined, and which of it needs repairing. */
export type AbsentTextPage = {
  /** Ids on this page whose publisher text is one of the source's markers. */
  ids: SafeId<"caseLawDecision">[];
  /** Rows the page examined, matching or not. Zero ends the walk. */
  scanned: number;
  /** Where the next page starts, or null when the source is exhausted. */
  cursor: AbsentTextCursor | null;
};

/** The sources a walk owns, looked up once by the adapters that declare a marker. */
export const absentTextSourcesStatement = (
  adapterKeys: readonly string[],
): SQL =>
  adapterKeys.length === 0
    ? sql`SELECT id, adapter_key FROM case_law_sources WHERE false`
    : sql`
        SELECT id, adapter_key
          FROM case_law_sources
         WHERE adapter_key = ANY(${textArray(adapterKeys)})
      `;

/** One source a walk visits, with the markers its adapter declares. */
export type AbsentTextSource = {
  adapterKey: string;
  sourceId: SafeId<"caseLawSource">;
};

const requiredString = (value: unknown, column: string): string => {
  if (typeof value !== "string") {
    return panic(`absent-text page column ${column} is not a string`);
  }
  return value;
};

export const parseAbsentTextSources = (
  rows: readonly unknown[],
): AbsentTextSource[] =>
  rows.map((row) => {
    if (!isRecord(row)) {
      return panic(`Unreadable case-law source row: ${JSON.stringify(row)}`);
    }
    return {
      adapterKey: requiredString(row["adapter_key"], "adapter_key"),
      sourceId: brandPersistedCaseLawSourceId(requiredString(row["id"], "id")),
    };
  });

/**
 * One page of a walk of a source, and whichever of its rows carry one of that
 * source's markers under a publisher-summary key.
 *
 * The bound is on rows examined, not on rows matched, and that is the whole
 * point. The population thins out as a repair proceeds, so a statement whose
 * `LIMIT` counts matches scans forward until it finds them — and the last such
 * statement, with no matches left to find, reads every remaining row of the
 * source and is cancelled by the lane's statement timeout. Here the page takes
 * a fixed number of rows in index order and the marker predicate runs over
 * those rows alone, so every statement of the walk costs the same bounded
 * amount whatever the data holds.
 *
 * The order is the source's own cursor index (`source_id, created_at, id`), so
 * a page is an index range rather than a sort of everything the source holds.
 * The primary key would have been the obvious cursor and the wrong one: it is
 * random per row, so ordering by it reads the whole partition before serving
 * the first page.
 *
 * The bound comes back on every row, including on a page that matched nothing,
 * because a page that advances no cursor is a walk that never ends. A source
 * with no rows past the cursor returns nothing at all, which is the one way
 * the walk finishes.
 *
 * A report and an apply read this same statement, so what a run says it would
 * change is what a run with `--apply` changes.
 */
export const selectAbsentTextPageStatement = ({
  after,
  markers,
  pageSize,
  sourceId,
}: {
  after: AbsentTextCursor | null;
  markers: readonly string[];
  pageSize: number;
  sourceId: SafeId<"caseLawSource">;
}): SQL => sql`
  WITH page AS (
    SELECT d.id, d.created_at, d.metadata
      FROM case_law_decisions d
     WHERE d.source_id = ${sourceId}::uuid
       ${
         after === null
           ? sql``
           : sql`AND (d.created_at, d.id) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`
       }
     ORDER BY d.created_at, d.id
     LIMIT ${pageSize}
  ),
  bound AS (
    SELECT created_at, id, (SELECT count(*) FROM page)::int AS scanned
      FROM page
     ORDER BY created_at DESC, id DESC
     LIMIT 1
  )
  SELECT b.created_at AS cursor_created_at,
         b.id AS cursor_id,
         b.scanned AS scanned,
         p.id AS match_id
    FROM bound b
    LEFT JOIN page p
      ON cardinality(${
        markers.length === 0
          ? sql`ARRAY[]::text[]`
          : absentPublisherTextKeys(sql`p.metadata`, markers)
      }) > 0
`;

/**
 * A page read back from a driver result that is untyped by construction.
 *
 * An empty result is the end of the walk; anything else states the bound on
 * every row, so the first row is enough to read it from.
 */
export const parseAbsentTextPage = (
  rows: readonly unknown[],
): AbsentTextPage => {
  const first = rows.at(0);
  if (first === undefined) {
    return { ids: [], scanned: 0, cursor: null };
  }
  if (!isRecord(first) || typeof first["scanned"] !== "number") {
    return panic(`Unreadable absent-text page: ${JSON.stringify(first)}`);
  }
  const createdAt = first["cursor_created_at"];
  const cursor: AbsentTextCursor = {
    createdAt:
      createdAt instanceof Date
        ? createdAt.toISOString()
        : requiredString(createdAt, "cursor_created_at"),
    id: brandPersistedCaseLawDecisionId(
      requiredString(first["cursor_id"], "cursor_id"),
    ),
  };

  const ids: SafeId<"caseLawDecision">[] = [];
  for (const row of rows) {
    if (!isRecord(row) || row["match_id"] === null) {
      continue;
    }
    ids.push(
      brandPersistedCaseLawDecisionId(
        requiredString(row["match_id"], "match_id"),
      ),
    );
  }

  return { ids, scanned: first["scanned"], cursor };
};

/**
 * A row still carrying one of the given markers, for the write's own re-check
 * against the row as it stands rather than as a page read it.
 */
export const carriesAbsentPublisherText = (markers: readonly string[]): SQL =>
  markers.length === 0
    ? sql`false`
    : sql`cardinality(${absentPublisherTextKeys(
        sql`${caseLawDecisions.metadata}`,
        markers,
      )}) > 0`;

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
export const strippedPublisherMetadata = (
  markers: readonly string[],
): SQL<Record<string, unknown>> =>
  sql`${caseLawDecisions.metadata} - ${absentPublisherTextKeys(
    sql`${caseLawDecisions.metadata}`,
    markers,
  )}`;
