/**
 * Re-attribute stored `cz-ns` decisions to the court that decided them.
 *
 * The Czech Supreme Court's database publishes selected decisions of other
 * courts beside its own, and the adapter labelled every row it wrote with the
 * publisher's name. Those rows name a court that did not decide them, and the
 * authority tier is read off the court name, so a regional judgment stored
 * that way also ranks as a supreme one.
 *
 * **What the repair reads.** Each row's own stored ECLI, whose third segment
 * is the deciding court's abbreviation, resolved through the same map the
 * fixed adapter resolves through. Nothing is fetched from the publisher: the
 * signal is already in the row.
 *
 * **What it does not reach.** A row whose ECLI is null carries no court signal
 * of its own, so it keeps the publisher's court until the crawl re-ingests it
 * and the adapter reads the detail page's own `Soud` row. A code the map does
 * not know is reported and left alone rather than written to a guess.
 *
 * **Re-projection.** The court is part of the projected document and of the
 * projection fingerprint, so a changed row has to be re-appended. The write
 * takes the corpus projection source lock and reconciles the row's desired
 * state in the same transaction, exactly as the ingestion pipeline does for
 * its own metadata-only updates; the projection workers then pick the row up
 * as ordinary work.
 *
 * **What it does not refresh.** Citation authority scores of the decisions
 * these rows cite are weighted by the citing court, and the rolling sweep
 * re-computes them over its own window; run `backfill-citation-authority.ts`
 * to close it sooner.
 *
 * Idempotent: a re-attributed row matches the stored court the next run
 * derives, and is counted as held.
 *
 * **How it walks.** A page at a time, bounded by rows examined rather than by
 * rows matched, in the order of the source's own cursor index. The population
 * is a few hundred rows among the source's many thousands, so a selection
 * bounded by matches reads to the end of the source looking for the ones that
 * are not there, and is cancelled by the lane's statement timeout before it
 * reports anything. Both modes read through the same statement, so what a
 * report says it would change is what an apply changes.
 *
 *   # what the repair would change, writing nothing
 *   bun run src/scripts/repair-cz-ns-court.ts
 *
 *   # re-attribute, bounded and resumable by re-running
 *   bun run src/scripts/repair-cz-ns-court.ts --apply [--limit 5000] [--page 2000]
 */

import { panic } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { executedRows } from "@/api/lib/db/executed-rows";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  applyCzNsCourtRepairStatement,
  CZ_NS_COURT_REPAIR_OUTCOMES,
  czNsSourceIdStatement,
  decideCzNsCourtRepair,
  parseCzNsCourtPage,
  parseCzNsSourceId,
  selectCzNsCourtPageStatement,
} from "@/api/scripts/repair-cz-ns-court-plan";
import type {
  CzNsCourtCursor,
  CzNsCourtPage,
  CzNsCourtReattribution,
} from "@/api/scripts/repair-cz-ns-court-plan";
import { flagInteger, readApplyFlag } from "@/api/scripts/repair-flags";

/** The publisher's own ECLI court code; its rows need no re-attribution. */
const CZ_NS_PUBLISHER_ECLI_CODE = "NS";

/**
 * Rows one page of the walk examines, matching or not.
 *
 * This is what bounds a statement, so it is the number that keeps the walk
 * inside the lane's statement timeout: the population is a few hundred rows
 * among the source's many thousands, and a selection bounded by matches
 * instead reads to the end of the source looking for the ones that are not
 * there. An operator meeting a slower database lowers it rather than raising
 * a timeout.
 */
const DEFAULT_PAGE_SIZE = 2000;

/**
 * Rows this run may re-attribute. The affected population is a few hundred,
 * so a run that discovers otherwise should stop and report rather than
 * rewrite a corpus an operator did not authorise.
 */
const DEFAULT_LIMIT = 5000;

const USAGE = `Usage: bun run src/scripts/repair-cz-ns-court.ts [options]

  --apply        Write the re-attributions. Omitted, the run only reports.
  --dry-run      Report only, the default. Accepted so it cannot be mistaken
                 for a flag this script ignores; contradicts --apply.
  --limit <n>    Rows this run may re-attribute (default ${String(DEFAULT_LIMIT)}).
  --page <n>     Rows one statement examines (default ${String(DEFAULT_PAGE_SIZE)}).`;

const apply = readApplyFlag(USAGE);

// A report run only reads, so it takes no lane and cannot block a writer; the
// read-only session makes that a property of the connection, not a promise.
const { ingestionDb, rootDb } = apply
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

// Resolved once, by the adapter that wrote the rows: the walk below filters on
// the source id, which is the leading column of the index it reads in, rather
// than joining the source table on every page.
const sourceId = parseCzNsSourceId(
  executedRows(await rootDb.execute(czNsSourceIdStatement(ADAPTER_KEYS.CZ_NS))),
);
if (sourceId === null) {
  console.info(`No ${ADAPTER_KEYS.CZ_NS} source is registered; nothing to do.`);
  process.exit(0);
}

/** One page of the walk, strictly after `after`. */
const readPage = async (
  after: CzNsCourtCursor | null,
): Promise<CzNsCourtPage> =>
  parseCzNsCourtPage(
    executedRows(
      await rootDb.execute(
        selectCzNsCourtPageStatement({
          after,
          pageSize,
          publisherEcliCode: CZ_NS_PUBLISHER_ECLI_CODE,
          sourceId,
        }),
      ),
    ),
  );

/**
 * Re-attribute one row, and re-enqueue the projection that carries it.
 *
 * One row is the transaction, and the whole transaction: the write and the
 * projection reconcile have to commit together, or a row would carry its new
 * court while the index kept serving the old one, with nothing left to notice
 * — the row has by then left the selection predicate, so a later run does not
 * revisit it. Batching the writes would not change that, because the desired
 * state is reconciled per decision, and it would put the two on either side of
 * a statement boundary. The source lock, taken first, is what keeps a crawl
 * refreshing the same decision from interleaving with either half.
 *
 * Answers whether the row was written: a guarded update that matches nothing
 * is a row the crawl re-observed under the run, already carrying whatever the
 * fixed adapter derived, and this run has nothing to add to it.
 */
const reattributeRow = async (
  repair: CzNsCourtReattribution,
): Promise<boolean> =>
  await ingestionDb(async (tx) => {
    const subject = { family: "case_law", entityId: repair.id } as const;
    const lock = await lockActiveCorpusProjectionSourceTx(tx, subject);
    // audit: skip — operator repair of a derived attribution
    const written =
      executedRows(
        await tx.execute(
          applyCzNsCourtRepairStatement({
            court: repair.court,
            from: repair.from,
            id: repair.id,
          }),
        ),
      ).length > 0;
    if (written && lock !== null) {
      await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
        lock,
        subject,
      });
    }
    return written;
  });

let cursor: CzNsCourtCursor | null = null;
let scanned = 0;
let reattributed = 0;
let superseded = 0;
let held = 0;
const unknownCodes = new Map<string, number>();
const courts = new Map<string, number>();

while (reattributed + superseded < limit) {
  const page = await readPage(cursor);

  // The cursor advances by rows examined, not by rows matched. A page whose
  // rows all held is still progress, and a walk that only moved on a match
  // would read the same page forever once the last one was behind it.
  if (page.cursor === null) {
    break;
  }
  cursor = page.cursor;
  scanned += page.scanned;

  for (const row of page.rows) {
    // The allowance is per row, not per page: a page is read whole, so a run
    // with one slot left would otherwise write every re-attributable row on
    // it. What an operator authorised is the number of rows changed.
    if (reattributed + superseded >= limit) {
      break;
    }
    const repair = decideCzNsCourtRepair(row);
    switch (repair.outcome) {
      case CZ_NS_COURT_REPAIR_OUTCOMES.HELD: {
        held += 1;
        break;
      }
      case CZ_NS_COURT_REPAIR_OUTCOMES.UNKNOWN_CODE: {
        unknownCodes.set(repair.code, (unknownCodes.get(repair.code) ?? 0) + 1);
        break;
      }
      case CZ_NS_COURT_REPAIR_OUTCOMES.REATTRIBUTED: {
        courts.set(repair.court, (courts.get(repair.court) ?? 0) + 1);
        if (!apply) {
          reattributed += 1;
          break;
        }
        const written = await reattributeRow(repair);
        if (written) {
          reattributed += 1;
        } else {
          superseded += 1;
        }
        break;
      }
      default: {
        repair satisfies never;
        panic(`Unhandled cz-ns court repair: ${JSON.stringify(repair)}`);
      }
    }
  }
}

console.info(
  `${scanned.toLocaleString()} rows of the source examined: ` +
    `${reattributed.toLocaleString()} ${apply ? "re-attributed" : "would be re-attributed"}, ` +
    `${held.toLocaleString()} already correct, ` +
    `${superseded.toLocaleString()} changed under the run.`,
);
for (const [court, count] of [...courts].sort((a, b) => b[1] - a[1])) {
  console.info(`  ${String(count).padStart(6)}  ${court}`);
}
if (unknownCodes.size > 0) {
  console.error(
    "ECLI court codes the map does not know; these rows were left alone:",
  );
  for (const [code, count] of [...unknownCodes].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(count).padStart(6)}  ${code}`);
  }
}
if (!apply) {
  console.info("Report only. Re-run with --apply to write.");
}

process.exit(0);
