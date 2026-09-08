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
 * **What it changes.** The metadata key, and nothing else. The key is removed
 * rather than emptied, because that is what the fixed adapter now writes, and
 * an absent key is what the read path resolves past to the next source in its
 * list. The stored raw payload is untouched, so the sentence stays recoverable
 * from what the publisher actually served.
 *
 * **What re-projects.** Both index paths, per batch, inside the batch's own
 * transaction. `indexed_hash` is cleared with the metadata, because
 * `content_hash` covers the text payload only and a metadata-only change is
 * otherwise invisible to the `indexed_hash IS DISTINCT FROM content_hash`
 * staleness test. The final projection derives its desired fingerprint from
 * the publisher reading of `metadata`, so the batch synchronizes the desired
 * state of every row it changed under the source's projection lock: the
 * fingerprint moves, the row becomes eligible, and the append worker
 * re-projects it on its own schedule. Where no generation is active there is
 * no lock and no synchronization; the rows are repaired either way and the
 * next desired-state pass reads the repaired metadata.
 *
 * **Which sentences.** Only what an adapter declares in
 * `adapters/absent-source-text.ts`, over the publisher-summary metadata keys
 * the read path itself walks. Neither list is repeated here, so a source that
 * starts printing a new sentence extends this repair by being declared once.
 *
 * Without `--apply` nothing is written and nothing is locked: the run reports
 * the affected rows per source and exits. Idempotent either way — a repaired
 * row leaves the selection predicate, so a second pass finds nothing.
 *
 *   # what the repair would touch, writing nothing
 *   bun run src/scripts/repair-publisher-absent-text.ts
 *
 *   # repair, bounded and resumable by re-running
 *   bun run src/scripts/repair-publisher-absent-text.ts --apply [--limit 50000]
 *
 * Not a scheduled job: the write path stopped producing these rows when the
 * adapters started reading the markers, so this is a one-shot pass over the
 * rows that predate it, run by an operator who reads the report first.
 */

import { and, count, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  enterCaseLawMaintenanceLane,
  openCaseLawReadOnlySession,
} from "@/api/lib/case-law/maintenance-lane";
import {
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  carriesAbsentPublisherText,
  strippedPublisherMetadata,
} from "@/api/scripts/repair-publisher-absent-text-plan";

/**
 * Rows per transaction. The batch holds the source's projection lock while it
 * synchronizes each repaired row's desired state, and a live crawl of the same
 * source waits on it.
 */
const BATCH = 500;
/** Rows one run may repair unless `--limit` says otherwise. */
const DEFAULT_LIMIT = 50_000;

const USAGE = `Usage: bun run src/scripts/repair-publisher-absent-text.ts [options]

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

type AffectedSource = {
  adapterKey: string;
  rows: number;
  sourceId: SafeId<"caseLawSource">;
};

const survey = async (): Promise<AffectedSource[]> =>
  await rootDb.transaction(
    async (tx) =>
      await tx
        .select({
          adapterKey: caseLawSources.adapterKey,
          rows: count(),
          sourceId: caseLawSources.id,
        })
        .from(caseLawDecisions)
        .innerJoin(
          caseLawSources,
          eq(caseLawSources.id, caseLawDecisions.sourceId),
        )
        .where(carriesAbsentPublisherText)
        .groupBy(caseLawSources.id, caseLawSources.adapterKey),
  );

/**
 * One line per source, in a stable order for the report. Adapter keys are
 * identifiers, so they sort by code point rather than by anyone's locale.
 */
const byAdapterKey = (left: AffectedSource, right: AffectedSource): number => {
  if (left.adapterKey === right.adapterKey) {
    return 0;
  }
  return left.adapterKey < right.adapterKey ? -1 : 1;
};

const printSurvey = (sources: readonly AffectedSource[]): number => {
  console.info("--- rows carrying a source's absent-text marker ---");
  let total = 0;
  for (const { adapterKey, rows } of sources.toSorted(byAdapterKey)) {
    total += rows;
    console.info(`${adapterKey.padEnd(14)} ${String(rows).padStart(9)}`);
  }
  console.info(`${"total".padEnd(14)} ${String(total).padStart(9)}`);
  return total;
};

/**
 * Strip the markers from one batch of one source's rows.
 *
 * The rows are claimed with `FOR UPDATE` before the write, so the set that is
 * repaired is the set the projection is then told about: nothing can change a
 * claimed row between the two statements.
 */
const repairBatch = async (
  tx: Transaction,
  sourceId: SafeId<"caseLawSource">,
  size: number,
): Promise<SafeId<"caseLawDecision">[]> => {
  const claimed = await tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(eq(caseLawDecisions.sourceId, sourceId), carriesAbsentPublisherText),
    )
    .orderBy(caseLawDecisions.id)
    .limit(size)
    .for("update");
  if (claimed.length === 0) {
    return [];
  }
  // audit: skip — operator repair of public case-law metadata; no user action
  const repaired = await tx
    .update(caseLawDecisions)
    .set({ metadata: strippedPublisherMetadata, indexedHash: null })
    .where(
      inArray(
        caseLawDecisions.id,
        claimed.map(({ id }) => id),
      ),
    )
    .returning({ id: caseLawDecisions.id });
  return repaired.map(({ id }) => id);
};

/** One batch, and the projection told about it, in one transaction. */
const repairAndAnnounceBatch = async (
  sourceId: SafeId<"caseLawSource">,
  size: number,
): Promise<number> =>
  await rootDb.transaction(async (tx) => {
    const lock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
      family: "case_law",
      sourceId,
    });
    const repaired = await repairBatch(tx, sourceId, size);
    if (lock !== null) {
      for (const entityId of repaired) {
        // oxlint-disable-next-line no-db-await-in-loop/no-db-await-in-loop -- one bounded batch of rows, under a source lock this transaction already holds
        await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
          lock,
          subject: { family: "case_law", entityId },
        });
      }
    }
    return repaired.length;
  });

/**
 * Repair one source until its population is empty or the run's budget is
 * spent. Each batch depends on the previous one having committed, which is
 * what makes this a walk rather than a fan-out.
 */
const repairSource = async (
  sourceId: SafeId<"caseLawSource">,
  budget: number,
): Promise<number> => {
  if (budget <= 0) {
    return 0;
  }
  const repaired = await repairAndAnnounceBatch(
    sourceId,
    Math.min(BATCH, budget),
  );
  if (repaired === 0) {
    return 0;
  }
  return repaired + (await repairSource(sourceId, budget - repaired));
};

const affected = await survey();
const total = printSurvey(affected);

if (!apply) {
  console.info(
    "Report only: nothing written. Re-run with --apply to strip the markers " +
      "and re-enqueue the affected rows for projection.",
  );
  process.exit(0);
}

let repaired = 0;
for (const { adapterKey, sourceId } of affected.toSorted(byAdapterKey)) {
  const perSource = await repairSource(sourceId, limit - repaired);
  repaired += perSource;
  console.info(`${adapterKey.padEnd(14)} ${String(perSource).padStart(9)}`);
  if (repaired >= limit) {
    console.info(`stopped at --limit ${String(limit)}; re-run to continue`);
    break;
  }
}

console.info(
  `done: ${String(repaired)} rows repaired ` +
    `(survey reported ${String(total)} before the run).`,
);
console.info(
  "Both index paths are re-enqueued; they settle on their own schedules.",
);

// Re-surveyed rather than inferred from the counts above: a run that hit
// `--limit`, or raced a crawl of a source deployed without the fix, has counts
// that say otherwise.
printSurvey(await survey());

process.exit(0);
