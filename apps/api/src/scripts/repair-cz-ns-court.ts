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
 *   # what the repair would change, writing nothing
 *   bun run src/scripts/repair-cz-ns-court.ts
 *
 *   # re-attribute, bounded and resumable by re-running
 *   bun run src/scripts/repair-cz-ns-court.ts --apply [--limit 5000]
 */

import { panic } from "better-result";

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { isRecord } from "@/api/lib/type-guards";
import {
  applyCzNsCourtRepairStatement,
  CZ_NS_COURT_REPAIR_OUTCOMES,
  decideCzNsCourtRepair,
  executedRows,
  parseCzNsCourtRow,
  selectCzNsForeignCourtRowsStatement,
} from "@/api/scripts/repair-cz-ns-court-plan";
import type { CzNsCourtRow } from "@/api/scripts/repair-cz-ns-court-plan";

/** The publisher's own ECLI court code; its rows need no re-attribution. */
const CZ_NS_PUBLISHER_ECLI_CODE = "NS";

/** Rows read per selection round trip. */
const BATCH = 200;

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
  --limit <n>    Rows this run may re-attribute (default ${String(DEFAULT_LIMIT)}).`;

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const DECIMAL_INTEGER = /^\d+$/u;

const flagInteger = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return fallback;
  }
  const raw = process.argv[index + 1];
  const parsed =
    raw !== undefined && DECIMAL_INTEGER.test(raw)
      ? Number.parseInt(raw, 10)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(
      `--${name} must be a positive integer, got: ${raw ?? "(none)"}`,
    );
    console.error(USAGE);
    process.exit(1);
  }
  return parsed;
};

const apply = hasFlag("apply");
if (apply && hasFlag("dry-run")) {
  console.error("--apply and --dry-run contradict each other; pass one.");
  console.error(USAGE);
  process.exit(1);
}

// A report run only reads, so it takes no lane and cannot block a writer; the
// read-only session makes that a property of the connection, not a promise.
const { rootDb, ingestionDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();
const limit = flagInteger("limit", DEFAULT_LIMIT);

/** One keyset page of the selection, strictly after `after`. */
const readPage = async (
  after: SafeId<"caseLawDecision"> | null,
): Promise<CzNsCourtRow[]> =>
  executedRows(
    await rootDb.execute(
      selectCzNsForeignCourtRowsStatement({
        adapterKey: ADAPTER_KEYS.CZ_NS,
        after,
        limit: BATCH,
        publisherEcliCode: CZ_NS_PUBLISHER_ECLI_CODE,
      }),
    ),
  ).map(parseCzNsCourtRow);

let cursor: SafeId<"caseLawDecision"> | null = null;
let scanned = 0;
let reattributed = 0;
let superseded = 0;
let held = 0;
const unknownCodes = new Map<string, number>();
const courts = new Map<string, number>();

while (reattributed + superseded < limit) {
  const page = await readPage(cursor);

  const last = page.at(-1);
  if (last === undefined) {
    break;
  }
  cursor = last.id;
  scanned += page.length;

  for (const row of page) {
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
        // One transaction per row, through the ingestion role the pipeline
        // writes these tables with: the update and the projection reconcile
        // have to be atomic, and the source lock they take is what keeps a
        // concurrent crawl of the same decision from interleaving with them.
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one row per transaction under the projection source lock
        const written = await ingestionDb(async (tx) => {
          const subject = {
            family: "case_law",
            entityId: repair.id,
          } as const;
          const lock = await lockActiveCorpusProjectionSourceTx(tx, subject);
          // audit: skip — operator repair of a derived attribution
          const rows = executedRows(
            await tx.execute(
              applyCzNsCourtRepairStatement({
                court: repair.court,
                from: repair.from,
                id: repair.id,
              }),
            ),
          ).filter(isRecord);
          if (rows.length > 0 && lock !== null) {
            await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
              lock,
              subject,
            });
          }
          return rows.length > 0;
        });
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
  `${scanned.toLocaleString()} rows carry a non-publisher ECLI: ` +
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
