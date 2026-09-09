/**
 * Take a source's "not available" sentence back out of the rows that stored it
 * as a headnote.
 *
 * A publisher with no headnote for a decision may still print a sentence in
 * the field saying so. Until the adapters read those sentences as absence, one
 * was stored like any other publisher text: it fills the row's headnote, is
 * indexed as one — so it boosts every unrelated decision sharing its words —
 * and is shown to a reader as the sentence the case is known by. The write
 * path is fixed; this is the pass over what it already wrote.
 *
 * **Which sentences.** Only what an adapter declares in
 * `adapters/absent-source-text.ts`, and only for that adapter's own rows, over
 * the publisher-summary metadata keys the read path itself walks. A sentence
 * stripped from a source whose adapter does not read it would be written
 * straight back on the next crawl, so scope is what makes the repair a fixed
 * point. Neither list is repeated here: a source that starts printing a new
 * sentence extends this repair by being declared once.
 *
 * **What it changes.** The metadata key, and nothing else. The key is removed
 * rather than emptied, because that is what the fixed adapter now writes, and
 * an absent key is what the read path resolves past to the next source in its
 * list. The stored raw payload is untouched, so the sentence stays recoverable
 * from what the publisher actually served.
 *
 * **What re-projects.** Both index paths, per decision, inside the
 * transaction that repaired it. `indexed_hash` is cleared with the metadata,
 * because `content_hash` covers the text payload only and a metadata-only
 * change is otherwise invisible to the
 * `indexed_hash IS DISTINCT FROM content_hash` staleness test. The final
 * projection derives its desired fingerprint from the publisher reading of
 * `metadata`, so the row's desired state is synchronized under its source's
 * projection lock: the fingerprint moves, the row becomes eligible, and the
 * append worker re-projects it on its own schedule. Where no generation is
 * active there is no lock and no synchronization; the row is repaired either
 * way and the next desired-state pass reads the repaired metadata.
 *
 * **How it walks.** A page at a time, bounded by rows examined rather than by
 * rows matched, in the order of the source's own cursor index. The population
 * thins out as the repair proceeds, so a selection bounded by matches reads
 * further and further into the source looking for rows that are no longer
 * there, and is cancelled by the lane's statement timeout before it reports
 * anything. The cursor advances by the last row examined, so a page that
 * matched nothing is still progress. Both modes read through the same
 * statement and stop at the same `--limit`, so what a report says it would
 * change is what an apply changes. An operator meeting a slower database
 * lowers `--page` rather than raising a timeout.
 *
 * Idempotent: a repaired row no longer carries a marker, so a later run walks
 * past it.
 *
 *   # what the repair would change, writing nothing
 *   bun run src/scripts/repair-publisher-absent-text.ts
 *
 *   # repair, bounded and resumable by re-running
 *   bun run src/scripts/repair-publisher-absent-text.ts --apply [--limit 50000] [--page 2000]
 *
 * Not a scheduled job: the write path stopped producing these rows when the
 * adapters started reading the markers, so this is a one-shot pass over the
 * rows that predate it, run by an operator who reads the report first.
 */

import { and, eq } from "drizzle-orm";

import { caseLawDecisions } from "@/api/db/schema";
import type { AdapterKey } from "@/api/handlers/case-law/consts";
import {
  ADAPTERS_DECLARING_ABSENT_TEXT,
  absentTextComparisonsFor,
} from "@/api/handlers/case-law/ingestion/adapters/absent-source-text";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  flagInteger,
  readApplyFlag,
  rejectUnknownFlags,
} from "@/api/scripts/repair-flags";
import {
  absentTextSourcesStatement,
  carriesAbsentPublisherText,
  parseAbsentTextPage,
  parseAbsentTextSources,
  selectAbsentTextPageStatement,
  strippedPublisherMetadata,
} from "@/api/scripts/repair-publisher-absent-text-plan";
import type {
  AbsentTextCursor,
  AbsentTextPage,
} from "@/api/scripts/repair-publisher-absent-text-plan";

/**
 * Rows one page of the walk examines, matching or not.
 *
 * This is what bounds a statement, so it is the number that keeps the walk
 * inside the lane's statement timeout: the rows still carrying a marker thin
 * out as a run proceeds, and a selection bounded by matches instead reads to
 * the end of the source looking for the ones that are not there. An operator
 * meeting a slower database lowers it rather than raising a timeout.
 */
const DEFAULT_PAGE_SIZE = 2000;
/** Rows one run may repair unless `--limit` says otherwise. */
const DEFAULT_LIMIT = 50_000;

const USAGE = `Usage: bun run src/scripts/repair-publisher-absent-text.ts [options]

  --apply        Write the repairs. Omitted, the run only reports.
  --dry-run      Report only, the default. Accepted so it cannot be mistaken
                 for a flag this script ignores; contradicts --apply.
  --limit <n>    Rows this run may repair, and rows a report may promise
                 (default ${String(DEFAULT_LIMIT)}).
  --page <n>     Rows one statement examines (default ${String(DEFAULT_PAGE_SIZE)}).`;

// Before anything is opened or locked: a run that names a flag this repair
// does not have is a run whose operator expects something else of it. The
// source-scoping and resume flags an earlier revision documented are among
// them, and widening silently from one source to all of them is exactly the
// outcome the check exists to prevent.
rejectUnknownFlags({ known: ["limit", "page"], usage: USAGE });

const apply = readApplyFlag(USAGE);

// A report run only reads, so it takes no lane and cannot block a writer; the
// read-only session makes that a property of the connection, not a promise.
const { rootDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();
const limit = flagInteger({
  fallback: DEFAULT_LIMIT,
  name: "limit",
  usage: USAGE,
});
const pageSize = flagInteger({
  fallback: DEFAULT_PAGE_SIZE,
  name: "page",
  usage: USAGE,
});

/** One source to walk, with the markers its adapter declares. */
type MarkedSource = {
  adapter: AdapterKey;
  markers: readonly string[];
  sourceId: SafeId<"caseLawSource">;
};

// Resolved once, by the adapters that declare a marker: the walk filters on
// the source id, which is the leading column of the index it reads in, rather
// than joining the source table on every page.
const sources: MarkedSource[] = parseAbsentTextSources(
  executedRows(
    await rootDb.execute(
      absentTextSourcesStatement(ADAPTERS_DECLARING_ABSENT_TEXT),
    ),
  ),
).flatMap(({ adapterKey, sourceId }) => {
  const adapter = ADAPTERS_DECLARING_ABSENT_TEXT.find(
    (declared) => declared === adapterKey,
  );
  return adapter === undefined
    ? []
    : [{ adapter, markers: absentTextComparisonsFor(adapter), sourceId }];
});

if (sources.length === 0) {
  console.info("No source of a declared absent-text marker is registered.");
  process.exit(0);
}

/** One page of one source's walk, strictly after `after`. */
const readPage = async (
  source: MarkedSource,
  after: AbsentTextCursor | null,
): Promise<AbsentTextPage> =>
  parseAbsentTextPage(
    executedRows(
      await rootDb.execute(
        selectAbsentTextPageStatement({
          after,
          markers: source.markers,
          pageSize,
          sourceId: source.sourceId,
        }),
      ),
    ),
  );

/**
 * Strip one row's markers and tell the projection, in one transaction.
 *
 * The row is re-read under the predicate rather than trusted from the page: a
 * decision the crawl re-observed in between already carries whatever the write
 * path allowed, and this run must not undo that. A row that changed under the
 * run is reported as superseded rather than repaired.
 */
const repairRow = async (
  source: MarkedSource,
  entityId: SafeId<"caseLawDecision">,
): Promise<boolean> =>
  await rootDb.transaction(async (tx) => {
    const lock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
      family: "case_law",
      sourceId: source.sourceId,
    });
    // audit: skip — operator repair of public case-law metadata; no user action
    const repaired = await tx
      .update(caseLawDecisions)
      .set({
        metadata: strippedPublisherMetadata(source.markers),
        indexedHash: null,
      })
      .where(
        and(
          eq(caseLawDecisions.id, entityId),
          carriesAbsentPublisherText(source.markers),
        ),
      )
      .returning({ id: caseLawDecisions.id });
    if (repaired.length === 0) {
      return false;
    }
    if (lock !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock,
        subject: { family: "case_law", entityId },
      });
    }
    return true;
  });

let scanned = 0;
/**
 * Rows changed, or — in a report — rows that would be changed. One counter for
 * both, because `--limit` bounds the report exactly as it bounds the apply it
 * previews: a report that walked past the allowance would promise a run the
 * apply then stops short of.
 */
let repaired = 0;
let superseded = 0;

for (const source of sources) {
  let cursor: AbsentTextCursor | null = null;
  let examinedHere = 0;

  while (repaired + superseded < limit) {
    const page = await readPage(source, cursor);

    // The cursor advances by rows examined, not by rows matched. A page whose
    // rows all held is still progress, and a walk that only moved on a match
    // would read the same page forever once the last one was behind it.
    if (page.cursor === null) {
      break;
    }
    cursor = page.cursor;
    examinedHere += page.scanned;
    scanned += page.scanned;

    for (const entityId of page.ids) {
      // The allowance is per row, not per page: a page is read whole, so a run
      // with one slot left would otherwise write every matching row on it.
      // What an operator authorised is the number of rows changed.
      if (repaired + superseded >= limit) {
        break;
      }
      if (!apply) {
        repaired += 1;
        continue;
      }
      if (await repairRow(source, entityId)) {
        repaired += 1;
      } else {
        superseded += 1;
      }
    }
  }

  console.info(
    `${source.adapter.padEnd(14)} ${examinedHere.toLocaleString()} rows examined`,
  );
}

console.info(
  apply
    ? `${scanned.toLocaleString()} rows examined: ` +
        `${repaired.toLocaleString()} repaired, ` +
        `${superseded.toLocaleString()} changed under the run.`
    : `${scanned.toLocaleString()} rows examined: ` +
        `${repaired.toLocaleString()} would be repaired.`,
);
if (repaired + superseded >= limit) {
  console.info(
    `Stopped at --limit ${String(limit)}; re-run to continue where this left off.`,
  );
}

console.info(
  apply
    ? "Both index paths are re-enqueued; they settle on their own schedules."
    : "Report only: nothing written. Re-run with --apply to strip the markers " +
        "and re-enqueue the affected rows for projection.",
);

process.exit(0);
