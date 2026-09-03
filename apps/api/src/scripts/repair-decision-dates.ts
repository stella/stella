/**
 * Repair `case_law_decisions.decision_date` values no publisher could have
 * meant.
 *
 * Rows written before the ingest bounded the field carry dates a court cannot
 * have issued: years in the twelfth century, years in the fourth millennium.
 * They sort, facet and filter as if they were real, and the corpus index seeds
 * its date field from this column, so every projection built on top of them
 * inherits the fault.
 *
 * **What a repair can recover.** Almost nothing, and the run proves it per row
 * rather than assuming it. The only cheap alternative source a row carries is
 * its own `metadata.decisionDate`, which is put through the same
 * `canonicalDecisionDate` the ingest writes through. For every adapter that
 * normalizes a date, metadata holds the normalized value, and `cz-regional` —
 * whose rows are almost all of this population — copies the publisher's string
 * into the column and into metadata unchanged. `sourceRaw` is not consulted: it
 * lives in object storage, so reading it costs a network round-trip per row,
 * and it holds the same publisher payload the corrupt value was taken from.
 *
 * **Nulling is the designed outcome, not a concession.** The column is
 * nullable, readers already render a decision with no date, and an absent date
 * is something a sort, a facet and the citation resolver can each handle
 * correctly. A year of 1168 is something none of them can. `metadata.publishedDate`
 * is deliberately not substituted: publication is not decision, and replacing a
 * visibly wrong date with a plausibly wrong one is worse than an honest gap.
 *
 * **What a date change costs elsewhere.** Two things, both handled per batch:
 * the search projection is re-enqueued by clearing `indexed_hash` in the same
 * statement, and the citation graph is told, because the resolver filters
 * candidates on `decision_date` and treats NULL on either side as permissive.
 * Edges decided under the old date are retracted and requeued through the same
 * helpers the ingestion pipeline uses when a stored decision's resolution
 * identity changes, under the citation-graph lock — and in the pipeline's lock
 * order, decision rows before the graph, so a refresh of one of these decisions
 * running at the same time cannot deadlock against the repair.
 *
 * **The bounds are also a CHECK constraint.** `case_law_decisions_decision_date_bounds`
 * (migrations 20260818090000 and 20260902100000) holds the same predicate,
 * derived from the same `DECISION_DATE_BOUNDS`. Its `VALIDATE CONSTRAINT` fails while a corrupt row
 * survives, and until then `ADD CONSTRAINT … NOT VALID` makes any unrelated
 * write touching such a row — a citation authority refresh, a corpus mirror
 * update, an index hash — fail on a column it never mentioned. The migrate
 * entrypoint therefore runs these same batches itself, as the online repair in
 * `db/decision-date-ceiling-repair.ts`, and validates the constraint once the
 * selection is empty; an upgrade needs no operator step. This script is the
 * report an operator reads, and a way to run the batches ahead of an upgrade.
 * Once the constraint is validated the selection is empty by construction.
 *
 * Without `--apply` nothing is written and nothing is locked: the run reports
 * the population per source and per year, then how many of those rows a repair
 * would re-derive and how many it would clear, and exits. Those last two are
 * what an operator authorises on, because a cleared row loses its date for
 * good. Idempotent either way — a repaired row leaves the selection predicate,
 * so a second pass finds nothing.
 *
 *   # what the repair would touch, writing nothing
 *   bun run src/scripts/repair-decision-dates.ts
 *
 *   # repair, bounded and resumable by re-running
 *   bun run src/scripts/repair-decision-dates.ts --apply [--limit 5000]
 *
 * Not a scheduled job: the write path has bounded new dates since the guard
 * landed, so this is a one-shot operation on the rows that predate it, run by
 * an operator who reads the report first.
 */

import { panic } from "better-result";

import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import { isRecord } from "@/api/lib/type-guards";
import type { DecisionDateRepairBatch } from "@/api/scripts/repair-decision-dates-plan";
import {
  DECISION_DATE_REPAIR_OUTCOMES,
  DECISION_DATE_ROW_LOCKS,
  decideDecisionDateRepair,
  decisionDateSourceSurveyStatement,
  decisionDateYearSurveyStatement,
  executedRows,
  parseCorruptDecisionDateRow,
  repairDecisionDateBatch,
  selectCorruptDecisionDatesStatement,
} from "@/api/scripts/repair-decision-dates-plan";

/**
 * Rows per transaction. Small on purpose: the batch holds the citation-graph
 * advisory lock while it reopens edges, and the standing resolver waits on it.
 */
const BATCH = 50;
/**
 * Rows this run may repair. The population is bounded by construction, but an
 * operator run that discovers otherwise should stop and report rather than walk
 * a table for an hour.
 */
const DEFAULT_LIMIT = 5000;
/** Survey rows printed. A result at the cap is reported as truncated. */
const SURVEY_LIMIT = 200;

const USAGE = `Usage: bun run src/scripts/repair-decision-dates.ts [options]

  --apply        Write the repairs. Omitted, the run only reports.
  --dry-run      Report only, the default. Accepted so it cannot be mistaken
                 for a flag this script ignores; contradicts --apply.
  --limit <n>    Rows this run may repair (default ${String(DEFAULT_LIMIT)}).`;

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
const { rootDb } = apply
  ? await enterCaseLawMaintenanceLane()
  : await openCaseLawReadOnlySession();
const limit = flagInteger("limit", DEFAULT_LIMIT);

const surveyNumber = (row: Record<string, unknown>, key: string): number => {
  const value = row[key];
  if (typeof value !== "number") {
    panic(`Survey column ${key} is not a number`);
  }
  return value;
};

const surveyText = (row: Record<string, unknown>, key: string): string => {
  const value = row[key];
  if (value === null) {
    return "—";
  }
  if (typeof value !== "string") {
    panic(`Survey column ${key} is not text`);
  }
  return value;
};

const printSurvey = async (): Promise<number> => {
  const bySource = executedRows(
    await rootDb.execute(decisionDateSourceSurveyStatement(SURVEY_LIMIT)),
  ).filter(isRecord);
  const byYear = executedRows(
    await rootDb.execute(decisionDateYearSurveyStatement(SURVEY_LIMIT)),
  ).filter(isRecord);

  console.info("--- out-of-bounds decision dates, per source ---");
  let total = 0;
  for (const row of bySource) {
    const rows = surveyNumber(row, "rows");
    total += rows;
    console.info(
      `${surveyText(row, "adapterKey").padEnd(14)} ${String(rows).padStart(7)}  ` +
        `${surveyText(row, "minDate")} … ${surveyText(row, "maxDate")}`,
    );
  }
  console.info(`${"total".padEnd(14)} ${String(total).padStart(7)}`);

  console.info("--- and per year ---");
  for (const row of byYear) {
    console.info(
      `${surveyText(row, "adapterKey").padEnd(14)} ${String(surveyNumber(row, "year")).padStart(6)}  ${String(surveyNumber(row, "rows")).padStart(7)}`,
    );
  }
  if (bySource.length >= SURVEY_LIMIT || byYear.length >= SURVEY_LIMIT) {
    console.info(
      `survey truncated at ${String(SURVEY_LIMIT)} rows; the counts above are a floor`,
    );
  }
  return total;
};

const repairBatch = async (size: number): Promise<DecisionDateRepairBatch> =>
  await rootDb.transaction(async (tx) => {
    const batch = await repairDecisionDateBatch(tx, size);
    for (const row of batch.unannounced) {
      console.error(
        `${row.id}: country ${row.country} declares no resolution policy; key not re-announced`,
      );
    }
    return batch;
  });

/**
 * Repair batches until the population is empty or `--limit` is reached.
 *
 * Each batch depends on the previous one having committed, which is what makes
 * this a walk rather than a fan-out.
 */
const repairUntilDone = async (counts: {
  cleared: number;
  rederived: number;
  skipped: number;
}): Promise<void> => {
  const done = counts.cleared + counts.rederived + counts.skipped;
  if (done >= limit) {
    return;
  }
  const batch = await repairBatch(Math.min(BATCH, limit - done));
  if (batch.cleared + batch.rederived + batch.skipped === 0) {
    return;
  }
  counts.cleared += batch.cleared;
  counts.rederived += batch.rederived;
  counts.skipped += batch.skipped;
  console.info(
    `${String(counts.cleared + counts.rederived)} repaired (${String(counts.rederived)} re-derived)`,
  );
  await repairUntilDone(counts);
};

/**
 * What the repair would decide, without writing or claiming anything.
 *
 * The counts an operator authorises on are these, not the population size: a
 * cleared row loses its date for good, so how many rows that is has to be on
 * the report rather than discovered afterwards.
 */
const printDecisions = async (): Promise<void> => {
  const rows = executedRows(
    await rootDb.execute(
      selectCorruptDecisionDatesStatement({
        limit,
        lock: DECISION_DATE_ROW_LOCKS.NONE,
      }),
    ),
  ).map(parseCorruptDecisionDateRow);
  const decided = rows.map(decideDecisionDateRepair);
  const rederived = decided.filter(
    ({ outcome }) => outcome === DECISION_DATE_REPAIR_OUTCOMES.REDERIVED,
  ).length;
  console.info("--- what a repair would decide ---");
  console.info(`re-derived from metadata: ${String(rederived)}`);
  console.info(
    `cleared to NULL:          ${String(decided.length - rederived)}`,
  );
  if (rows.length >= limit) {
    console.info(
      `decisions capped at --limit ${String(limit)}; the counts above are a floor`,
    );
  }
};

const total = await printSurvey();

if (!apply) {
  await printDecisions();
  console.info(
    "Report only: nothing written. Re-run with --apply to repair, and note " +
      "that a run reporting zero rows is the precondition for adding the " +
      "bounds CHECK constraint.",
  );
  process.exit(0);
}

const counts = { cleared: 0, rederived: 0, skipped: 0 };
await repairUntilDone(counts);

console.info(
  `done: ${String(counts.cleared)} cleared, ${String(counts.rederived)} re-derived, ` +
    `${String(counts.skipped)} already repaired by a concurrent observation ` +
    `(survey reported ${String(total)} before the run).`,
);
console.info(
  "The search projection is re-enqueued and the affected citations are back " +
    "in the resolver's queue; both settle on their own schedules.",
);

// Re-surveyed rather than inferred from the counts above: what the constraint
// needs is that the population is empty now, and a run that hit `--limit`, or
// raced a crawl still writing unbounded dates, has counts that say otherwise.
const remaining = await printSurvey();
console.info(
  remaining === 0
    ? "population empty: the bounds CHECK constraint can now be added."
    : `${String(remaining)} rows remain; re-run before adding the bounds CHECK constraint.`,
);

process.exit(0);
