import { panic } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type {
  CzRegionalApiItem,
  CzRegionalDayPage,
} from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import {
  buildCzRegionalDecision,
  isCzRegionalApiItem,
  listCzRegionalDayPage,
} from "@/api/handlers/case-law/ingestion/adapters/cz-regional";
import {
  allocateSourceObservationOrder,
  PROCESS_DECISION_STATUS,
  processDecision,
} from "@/api/handlers/case-law/ingestion/pipeline";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { refreshCorpusS3, refreshS3 } from "@/api/lib/s3";
import type {
  CzRegionalHeldIdentities,
  CzRegionalRepairArgs,
  CzRegionalRepairDay,
  CzRegionalRepairReport,
} from "@/api/scripts/cz-regional-repair-plan";
import {
  CZ_REGIONAL_FEED_START,
  CZ_REGIONAL_LANGUAGE,
  checkRepairRange,
  czRegionalListingKeys,
  diffCzRegionalListing,
  enumerateUtcDays,
  toUtcDateString,
} from "@/api/scripts/cz-regional-repair-plan";

/**
 * Reconcile the cz-regional source against the publisher's own day listings.
 *
 * The crawl reaches a decision by walking a date cursor forward, so anything
 * a page dropped while the cursor moved past it is never revisited: the
 * cursor is the only record of what was seen. The publisher's opendata
 * endpoint lists each day independently of that cursor, which makes the
 * question answerable — enumerate what a day lists, key each item the way
 * the ingest would key it, and compare against the identities already
 * stored.
 *
 * Only the missing ones are fetched in full. Each is built through the
 * adapter's own parse and finaldoc path and written by the ingestion
 * pipeline's `processDecision`, ordered on the source's observation counter
 * under its ingestion lease, so a run cannot interleave with a live crawl.
 * The default refresh policy is the right one here: this run exists to add
 * rows the source never stored, and a row that is already held is left
 * exactly as it is. Items whose document could not be read are left missing
 * rather than stored listing-only, so a later run finds them again instead of
 * reading the day as reconciled.
 *
 * Every run is bounded by `--limit` and continues from the resume point it
 * prints, in both modes: the walk's own accumulation is the cost without
 * `--apply`, just as pipeline writes are the cost with it.
 *
 * Without `--apply` nothing is fetched in full, nothing is leased and
 * nothing is written; the walk reports per-day and total missing counts and
 * writes the report file. The report carries the missing listing items
 * verbatim, so `--items-file` can process exactly them later — diffed again
 * first, because a file is a snapshot and the crawl keeps running. Failed
 * items are written the same way at the end of an apply run. Interrupt with
 * Ctrl-C: the current decision finishes and the report names the resume
 * point.
 *
 *   # what a run would visit, writing nothing
 *   bun run src/scripts/cz-regional-repair.ts --from 2026-01-01
 *
 *   # ingest the misses, resumable
 *   bun run src/scripts/cz-regional-repair.ts --from 2026-01-01 \
 *     --apply --limit 500 [--after <YYYY-MM-DD>]
 *
 *   # process exactly the items a previous run reported
 *   bun run src/scripts/cz-regional-repair.ts --apply \
 *     --items-file cz-regional-repair-failed.json
 *
 * Not a scheduled job: a deliberate operation under an operator who reads
 * the report.
 */

const DEFAULT_DELAY_MS = 250;
/**
 * Work items per run, in both modes: decisions written under `--apply`,
 * missing items recorded without it. The default range is the whole feed and
 * a sparsely stored source can miss most of it, so an uncapped run would hold
 * every raw item in memory and write one impractical report at the end. The
 * cap makes a run finite and the printed resume point continues it; pass
 * `--no-limit` for a deliberate single-pass census.
 */
const DEFAULT_LIMIT = 5000;
/** Identity lookups per query, matching the publisher's own page size. */
const HELD_LOOKUP_CHUNK = 100;
/** Consecutive failed items before the run halts; mirrors the re-fetch. */
const FAILURE_HALT_THRESHOLD = 10;
const LIST_TIMEOUT_MS = 60_000;
/**
 * Politeness pause between listing requests, matching the adapter's own
 * `minRequestIntervalMs`. The walk asks for one page per request and a full
 * range is thousands of them, so without a floor a plan-only run would hit
 * the publisher harder than the crawl it reconciles.
 */
const LIST_DELAY_MS = 200;
/** One finaldoc document; nothing here should take longer. */
const ITEM_FETCH_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_OUT = "cz-regional-repair-plan.json";
const DEFAULT_FAILED_OUT = "cz-regional-repair-failed.json";
const PROGRESS_EVERY = 25;

const USAGE = `Usage: bun run src/scripts/cz-regional-repair.ts [options]

  --from <YYYY-MM-DD>  First day listed (default ${CZ_REGIONAL_FEED_START}, the feed's start).
  --to <YYYY-MM-DD>    Last day listed (default today, UTC).
  --apply              Fetch and write the missing decisions. Omitted, the
                       run walks and diffs only.
  --out <path>         Where the walk's report is written (default ${DEFAULT_OUT}).
  --items-file <path>  Process the listing items in this JSON array instead of
                       walking, skipping any since stored; requires --apply.
  --limit <n>          Work items this run: decisions written under --apply,
                       missing items recorded without it (default ${DEFAULT_LIMIT}).
  --no-limit           Run the whole range in one pass, however large.
  --after <YYYY-MM-DD> Resume strictly after this day.
  --delay-ms <n>       Pause between decisions (default ${DEFAULT_DELAY_MS}).
  --failed-out <path>  Where failed items are written (default ${DEFAULT_FAILED_OUT}).`;

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    console.error(`--${name} requires a value`);
    console.error(USAGE);
    process.exit(1);
  }
  return value;
};

const hasFlag = (name: string): boolean => process.argv.includes(`--${name}`);

const DECIMAL_INTEGER = /^\d+$/u;

const positiveInteger = (
  raw: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = DECIMAL_INTEGER.test(raw)
    ? Number.parseInt(raw, 10)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    console.error(`--${name} must be a positive integer, got: ${raw}`);
    process.exit(1);
  }
  return parsed;
};

const noLimit = hasFlag("no-limit");
const limitFlag = flagValue("limit");
if (noLimit && limitFlag !== undefined) {
  console.error("--no-limit and --limit contradict each other; pass one.");
  console.error(USAGE);
  process.exit(1);
}

const args = {
  from: flagValue("from") ?? CZ_REGIONAL_FEED_START,
  to: flagValue("to") ?? toUtcDateString(new Date()),
  apply: hasFlag("apply"),
  outPath: flagValue("out") ?? DEFAULT_OUT,
  itemsFilePath: flagValue("items-file") ?? null,
  limit: noLimit ? null : positiveInteger(limitFlag, DEFAULT_LIMIT, "limit"),
  after: flagValue("after") ?? null,
  delayMs: positiveInteger(flagValue("delay-ms"), DEFAULT_DELAY_MS, "delay-ms"),
  failedOutPath: flagValue("failed-out") ?? DEFAULT_FAILED_OUT,
} satisfies CzRegionalRepairArgs;

const {
  after,
  apply,
  delayMs,
  failedOutPath,
  from,
  itemsFilePath,
  limit,
  outPath,
  to,
} = args;

const range = checkRepairRange({ from, to, after });
if (range.type === "invalid") {
  console.error(range.message);
  console.error(USAGE);
  process.exit(1);
}

if (itemsFilePath !== null && !apply) {
  console.error("--items-file names decisions to write; it requires --apply.");
  console.error(USAGE);
  process.exit(1);
}

const isCzRegionalItemArray = (value: unknown): value is CzRegionalApiItem[] =>
  Array.isArray(value) && value.every(isCzRegionalApiItem);

// Read and validated here, before the lease: a malformed entry deep in the
// file would otherwise burn the consecutive-failure budget mid-run and could
// halt a valid recovery.
const suppliedItems = await (async (): Promise<CzRegionalApiItem[] | null> => {
  if (itemsFilePath === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(await Bun.file(itemsFilePath).text());
  if (!isCzRegionalItemArray(parsed)) {
    console.error(`${itemsFilePath} is not a JSON array of listing items`);
    process.exit(1);
  }
  // Not truncated to --limit: the run halts on the cap and a re-run with the
  // same file picks up where it stopped, because everything already written
  // is now held and skipped.
  return parsed;
})();

const days =
  suppliedItems === null
    ? enumerateUtcDays({ from, to }).filter(
        (date) => after === null || date > after,
      )
    : [];

console.log("=== CZ-REGIONAL LISTING RECONCILIATION ===");
console.log(`mode:        ${apply ? "apply" : "plan only"}`);
if (suppliedItems === null) {
  console.log(`range:       ${from} … ${to}`);
  console.log(
    `days:        ${days.length}${after === null ? "" : ` (after ${after})`}`,
  );
} else {
  console.log(`items file:  ${itemsFilePath} (${suppliedItems.length} items)`);
}

// A plan run only reads, so it takes no lane and cannot block a writer; the
// read-only session makes that a property of the connection, not a promise.
const { ingestionDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();

const source = (
  await ingestionDb((tx) =>
    tx
      .select({ id: caseLawSources.id })
      .from(caseLawSources)
      .where(eq(caseLawSources.adapterKey, ADAPTER_KEYS.CZ_REGIONAL))
      .limit(1),
  )
).at(0);
if (!source) {
  console.error("No case-law source configured for adapter cz-regional");
  process.exit(1);
}
const sourceId = source.id;

/**
 * Which of a page's publisher document ids are already stored. Bounded by
 * the page the ids came from, which this API caps at 100 items.
 */
const selectHeldDocumentIds = async (
  documentIds: string[],
): Promise<string[]> => {
  if (documentIds.length === 0) {
    return [];
  }
  const rows = await ingestionDb((tx) =>
    tx
      .select({ sourceDocumentId: caseLawDecisions.sourceDocumentId })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          inArray(caseLawDecisions.sourceDocumentId, documentIds),
        ),
      )
      .limit(documentIds.length),
  );
  return rows.flatMap((row) =>
    row.sourceDocumentId === null ? [] : [row.sourceDocumentId],
  );
};

/**
 * The same question for the fallback half of the identity index: rows this
 * source stored without a publisher document id are keyed on the docket and
 * the language, so only those rows can answer for a listing item that
 * carries no link.
 */
const selectHeldCaseNumbers = async (
  caseNumbers: string[],
): Promise<string[]> => {
  if (caseNumbers.length === 0) {
    return [];
  }
  const rows = await ingestionDb((tx) =>
    tx
      .select({ caseNumber: caseLawDecisions.caseNumber })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          inArray(caseLawDecisions.caseNumber, caseNumbers),
          eq(caseLawDecisions.language, CZ_REGIONAL_LANGUAGE),
          isNull(caseLawDecisions.sourceDocumentId),
        ),
      )
      .limit(caseNumbers.length),
  );
  return rows.map((row) => row.caseNumber);
};

const heldIdentities = async (
  items: readonly CzRegionalApiItem[],
): Promise<CzRegionalHeldIdentities> => {
  const { documentIds, caseNumbers } = czRegionalListingKeys(items);
  const [heldDocumentIds, heldCaseNumbers] = await Promise.all([
    selectHeldDocumentIds(documentIds),
    selectHeldCaseNumbers(caseNumbers),
  ]);
  return {
    documentIds: new Set(heldDocumentIds),
    caseNumbers: new Set(heldCaseNumbers),
  };
};

/**
 * The same question over an arbitrary number of items, in bounded queries.
 * A report file carries as many items as a whole walk found, which is more
 * than one lookup may name.
 */
const heldIdentitiesChunked = async (
  items: readonly CzRegionalApiItem[],
): Promise<CzRegionalHeldIdentities> => {
  const documentIds = new Set<string>();
  const caseNumbers = new Set<string>();
  for (let index = 0; index < items.length; index += HELD_LOOKUP_CHUNK) {
    const held = await heldIdentities(
      items.slice(index, index + HELD_LOOKUP_CHUNK),
    );
    for (const value of held.documentIds) {
      documentIds.add(value);
    }
    for (const value of held.caseNumbers) {
      caseNumbers.add(value);
    }
  }
  return { documentIds, caseNumbers };
};

const INGEST_OUTCOMES = {
  WRITTEN: "written",
  RETRYABLE: "retryable",
  FAILED: "failed",
  /** The adapter would drop this item; a retry can never write it. */
  UNINGESTABLE: "uningestable",
} as const;

type IngestOutcome = (typeof INGEST_OUTCOMES)[keyof typeof INGEST_OUTCOMES];

const ingestItem = async (
  item: CzRegionalApiItem,
  lease: CaseLawSourceIngestionLease,
): Promise<IngestOutcome> => {
  const docket = item.jednaciCislo ?? "(no docket)";
  try {
    const built = await buildCzRegionalDecision(
      item,
      AbortSignal.timeout(ITEM_FETCH_TIMEOUT_MS),
    );
    if (built.type === "unkeyable") {
      console.error(`${docket}: no docket and court to key on; skipped`);
      return INGEST_OUTCOMES.UNINGESTABLE;
    }
    if (built.type === "detail-unavailable") {
      // Deliberately not written: a listing-only row would make the identity
      // held, and the next walk would report the day as reconciled while the
      // document stayed unread. Left missing, it is found again.
      console.error(`${docket}: document unavailable; left for a retry`);
      return INGEST_OUTCOMES.RETRYABLE;
    }
    const { decision } = built;
    await lease.beforeDatabaseMark();
    const observationOrder = await allocateSourceObservationOrder({
      leaseToken: lease.leaseToken,
      scopedDb: ingestionDb,
      sourceId,
    });
    const processed = await processDecision({
      input: decision,
      sourceId,
      scopedDb: ingestionDb,
      observedAt: new Date(),
      observationOrder,
    });
    if (processed.status === PROCESS_DECISION_STATUS.RETRYABLE) {
      console.error(`${decision.caseNumber}: retryable — ${processed.reason}`);
      return INGEST_OUTCOMES.RETRYABLE;
    }
    return INGEST_OUTCOMES.WRITTEN;
  } catch (error) {
    console.error(`${docket}: failed —`, error);
    return INGEST_OUTCOMES.FAILED;
  }
};

if (!apply) {
  console.log(
    "Plan only: nothing fetched in full, nothing written. Re-run with --apply.",
  );
}

if (apply) {
  await refreshS3();
  await refreshCorpusS3();
}

const sourceLease = apply
  ? await acquireCaseLawSourceIngestionLease({
      scopedDb: ingestionDb,
      sourceId,
    })
  : null;
if (apply && sourceLease === null) {
  console.error(
    "Source cz-regional is being ingested right now (lease held). Retry later.",
  );
  process.exit(1);
}

// Object-held so the flag's cross-callback mutation is visible to
// per-site flow analysis; a plain boolean reads as always-false.
const runState = { interrupted: false };
process.on("SIGINT", () => {
  runState.interrupted = true;
  console.error("interrupt received; finishing the current decision…");
});

type Halt = {
  reason: string;
  /** Whether the run should exit non-zero; an operator stop should not. */
  failure: boolean;
};

const counts = {
  listed: 0,
  held: 0,
  missing: 0,
  uningestable: 0,
  duplicate: 0,
  processed: 0,
  written: 0,
  retryable: 0,
};
const reportDays: CzRegionalRepairDay[] = [];
const missingItems: CzRegionalApiItem[] = [];
const failedItems: CzRegionalApiItem[] = [];
let consecutiveFailures = 0;
let halt: Halt | null = null;
/** Whether a listing request has already gone out, so the pause has an "each subsequent" to apply to. */
let listedAnyPage = false;
/** Last day walked end to end; the only safe resume boundary. */
let lastCompletedDate: string | null = null;

/**
 * What `--limit` counts. Under `--apply` the run's cost is the decisions it
 * puts through the pipeline; without it, the cost is the missing items it
 * accumulates for the report, and those must be capped just as hard or a
 * plan-only run over a sparsely stored range grows without bound.
 */
const workDone = (): number => (apply ? counts.processed : missingItems.length);

const stopReason = (): Halt | null => {
  if (runState.interrupted) {
    return { reason: "interrupted", failure: false };
  }
  if (consecutiveFailures >= FAILURE_HALT_THRESHOLD) {
    return {
      reason: `${FAILURE_HALT_THRESHOLD} consecutive items failed`,
      failure: true,
    };
  }
  if (limit !== null && workDone() >= limit) {
    return { reason: `--limit ${limit} reached`, failure: false };
  }
  return null;
};

const recordOutcome = (item: CzRegionalApiItem, outcome: IngestOutcome) => {
  counts.processed += 1;
  switch (outcome) {
    case INGEST_OUTCOMES.WRITTEN:
      counts.written += 1;
      consecutiveFailures = 0;
      break;
    case INGEST_OUTCOMES.UNINGESTABLE:
      counts.uningestable += 1;
      consecutiveFailures = 0;
      break;
    case INGEST_OUTCOMES.RETRYABLE:
      counts.retryable += 1;
      failedItems.push(item);
      consecutiveFailures += 1;
      break;
    case INGEST_OUTCOMES.FAILED:
      failedItems.push(item);
      consecutiveFailures += 1;
      break;
    default: {
      outcome satisfies never;
      panic(`Unhandled ingest outcome: ${String(outcome)}`);
    }
  }
  if (counts.processed % PROGRESS_EVERY === 0) {
    console.error(
      `progress: ${counts.processed} items, ${counts.written} written, ${failedItems.length} failed`,
    );
  }
};

try {
  if (suppliedItems === null) {
    for (const date of days) {
      halt = stopReason();
      if (halt !== null) {
        break;
      }
      const day: CzRegionalRepairDay = {
        date,
        listed: 0,
        held: 0,
        missing: 0,
      };
      let dayComplete = true;
      for (let page = 0; ; page += 1) {
        if (listedAnyPage) {
          await Bun.sleep(LIST_DELAY_MS);
        }
        listedAnyPage = true;
        let listed: CzRegionalDayPage;
        try {
          listed = await listCzRegionalDayPage({
            date,
            page,
            signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
          });
        } catch (error) {
          // The day is left unwalked rather than half-walked: advancing the
          // resume boundary past it would turn a transient listing failure
          // into a permanent gap.
          console.error(`${date} page ${page}: listing failed —`, error);
          halt = { reason: `listing failed on ${date}`, failure: true };
          dayComplete = false;
          break;
        }
        const held = await heldIdentities(listed.items);
        const diff = diffCzRegionalListing({ items: listed.items, held });
        day.listed += listed.items.length;
        day.held += diff.held.length;
        day.missing += diff.missing.length;
        counts.listed += listed.items.length;
        counts.held += diff.held.length;
        counts.missing += diff.missing.length;
        counts.uningestable += diff.unidentifiable.length;
        counts.duplicate += diff.duplicate.length;
        missingItems.push(...diff.missing);

        if (sourceLease !== null) {
          for (const item of diff.missing) {
            halt = stopReason();
            if (halt !== null) {
              dayComplete = false;
              break;
            }
            recordOutcome(item, await ingestItem(item, sourceLease));
            await Bun.sleep(delayMs);
          }
        }

        // Checked per page, not only per item: without --apply nothing walks
        // the missing list, so this is the only place the plan-only run's
        // accumulation is bounded.
        halt = stopReason();
        if (halt !== null) {
          dayComplete = false;
        }
        if (!dayComplete || page + 1 >= listed.totalPages) {
          break;
        }
      }
      reportDays.push(day);
      if (!dayComplete) {
        break;
      }
      lastCompletedDate = date;
      if (day.missing > 0 || day.listed > 0) {
        console.error(
          `${date}: listed ${day.listed}, held ${day.held}, missing ${day.missing}`,
        );
      }
    }
  } else if (sourceLease !== null) {
    // A file is a snapshot of what was missing when it was written, and the
    // crawl keeps running. Diffed again here so the run stays what it claims
    // to be — it adds rows the source does not hold — instead of replaying a
    // stale item over a newer one the crawl has since stored.
    const held = await heldIdentitiesChunked(suppliedItems);
    const fileDiff = diffCzRegionalListing({ items: suppliedItems, held });
    counts.listed += suppliedItems.length;
    counts.held += fileDiff.held.length;
    counts.missing += fileDiff.missing.length;
    counts.uningestable += fileDiff.unidentifiable.length;
    counts.duplicate += fileDiff.duplicate.length;
    for (const item of fileDiff.missing) {
      halt = stopReason();
      if (halt !== null) {
        break;
      }
      recordOutcome(item, await ingestItem(item, sourceLease));
      await Bun.sleep(delayMs);
    }
  }
} finally {
  if (sourceLease !== null) {
    await sourceLease.release();
  }
}

if (suppliedItems === null) {
  const report: CzRegionalRepairReport = {
    generatedAt: new Date().toISOString(),
    from,
    to,
    days: reportDays,
    missingItems,
  };
  await Bun.write(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report written to ${outPath}`);
}

console.log("--- outcomes ---");
if (suppliedItems === null) {
  console.log(`days visited:      ${reportDays.length} of ${days.length}`);
}
console.log(`items listed:      ${counts.listed}`);
console.log(`already held:      ${counts.held}`);
console.log(`missing:           ${counts.missing}`);
console.log(`duplicate listing: ${counts.duplicate}`);
if (apply) {
  console.log(`processed:         ${counts.processed}`);
  console.log(`written:           ${counts.written}`);
  console.log(`retryable:         ${counts.retryable}`);
}
console.log(`uningestable:      ${counts.uningestable}`);
if (failedItems.length > 0) {
  await Bun.write(failedOutPath, `${JSON.stringify(failedItems, null, 2)}\n`);
  console.log(`failed:            ${failedItems.length} → ${failedOutPath}`);
  console.log(`retry them with:   --items-file ${failedOutPath} --apply`);
}
if (halt !== null) {
  console.log(`halted:            ${halt.reason}`);
}
// The resume point is the last day walked end to end, never the last day
// touched: a day the run stopped inside is only partly reconciled.
if (
  suppliedItems === null &&
  days.length > 0 &&
  lastCompletedDate !== days.at(-1)
) {
  console.log(
    lastCompletedDate === null
      ? `resume with:       --from ${days.at(0) ?? from}`
      : `resume with:       --after ${lastCompletedDate}`,
  );
}
process.exit(halt?.failure === true ? 1 : 0);
