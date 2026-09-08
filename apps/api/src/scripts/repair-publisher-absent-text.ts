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
 * **How it walks.** Candidates are read a page at a time by a keyset cursor
 * over the source's ids, so each row is inspected once however many pages a
 * run takes, and a row the page did not repair is not met again. A run
 * reports the resume point it stopped at; passing it back as `--after`
 * continues from there.
 *
 * Without `--apply` nothing is written and nothing is locked: the run reports
 * the affected rows per source and exits. Idempotent either way — a repaired
 * row leaves the selection predicate, so a later run finds nothing.
 *
 *   # what the repair would touch, writing nothing
 *   bun run src/scripts/repair-publisher-absent-text.ts
 *
 *   # repair, bounded and resumable by re-running
 *   bun run src/scripts/repair-publisher-absent-text.ts --apply [--limit 50000]
 *
 *   # continue one source's walk from where a run stopped
 *   bun run src/scripts/repair-publisher-absent-text.ts --apply \
 *     --adapter cz-us --after <decisionId>
 *
 * Not a scheduled job: the write path stopped producing these rows when the
 * adapters started reading the markers, so this is a one-shot pass over the
 * rows that predate it, run by an operator who reads the report first.
 */

import { and, count, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
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
import {
  lockActiveCorpusProjectionSourceByIdTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  flagInteger,
  hasFlag,
  readApplyFlag,
} from "@/api/scripts/repair-flags";
import {
  carriesAbsentPublisherText,
  carriesDeclaredAbsentPublisherText,
  strippedPublisherMetadata,
} from "@/api/scripts/repair-publisher-absent-text-plan";

/**
 * Ids read per keyset page. The page is a plain id-range read; the writes it
 * leads to are one short transaction each, so the page size trades round trips
 * against how much of a walk an interrupted run loses.
 */
const PAGE = 500;
/** Rows one run may repair unless `--limit` says otherwise. */
const DEFAULT_LIMIT = 50_000;

const USAGE = `Usage: bun run src/scripts/repair-publisher-absent-text.ts [options]

  --apply        Write the repairs. Omitted, the run only reports.
  --dry-run      Report only, the default. Accepted so it cannot be mistaken
                 for a flag this script ignores; contradicts --apply.
  --limit <n>    Rows this run may repair (default ${String(DEFAULT_LIMIT)}).
  --after <id>   Resume one source's walk after this decision id. Requires a
                 single affected source, or --adapter to name one.
  --adapter <k>  Repair only this adapter's source.`;

const flagValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};

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
const adapterFilter = flagValue("adapter");
const resumeAfter = flagValue("after");

if (hasFlag("after") && resumeAfter === undefined) {
  console.error("--after needs a decision id.");
  console.error(USAGE);
  process.exit(1);
}

type AffectedSource = {
  adapter: AdapterKey;
  rows: number;
  sourceId: SafeId<"caseLawSource">;
};

/**
 * The stored adapter key as the declared one it names.
 *
 * Matched against the declarations rather than asserted from the column: the
 * markers to strip are looked up by this value, so a source whose key names no
 * declaring adapter has nothing to strip and drops out of the walk. The survey
 * predicate already judges each row by its own adapter, so this cannot lose an
 * affected source.
 */
const declaringAdapter = (adapterKey: string): AdapterKey | undefined =>
  ADAPTERS_DECLARING_ABSENT_TEXT.find((adapter) => adapter === adapterKey);

const survey = async (): Promise<AffectedSource[]> => {
  const rows = await rootDb.transaction(
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
        .where(carriesDeclaredAbsentPublisherText)
        .groupBy(caseLawSources.id, caseLawSources.adapterKey),
  );
  return rows.flatMap(({ adapterKey, rows: affectedRows, sourceId }) => {
    const adapter = declaringAdapter(adapterKey);
    return adapter === undefined
      ? []
      : [{ adapter, rows: affectedRows, sourceId }];
  });
};

/**
 * One line per source, in a stable order for the report. Adapter keys are
 * identifiers, so they sort by code point rather than by anyone's locale.
 */
const byAdapterKey = (left: AffectedSource, right: AffectedSource): number => {
  if (left.adapter === right.adapter) {
    return 0;
  }
  return left.adapter < right.adapter ? -1 : 1;
};

const printSurvey = (sources: readonly AffectedSource[]): number => {
  console.info("--- rows carrying their source's absent-text marker ---");
  let total = 0;
  for (const { adapter, rows } of sources.toSorted(byAdapterKey)) {
    total += rows;
    console.info(`${adapter.padEnd(14)} ${String(rows).padStart(9)}`);
  }
  console.info(`${"total".padEnd(14)} ${String(total).padStart(9)}`);
  return total;
};

type SourceWalk = {
  markers: readonly string[];
  sourceId: SafeId<"caseLawSource">;
};

/**
 * The next page of candidate ids after the cursor.
 *
 * The page is bounded by both the cursor and the predicate, so a source's
 * population is read once across a whole walk rather than re-scanned per
 * batch, and an id the page passed over is never met again.
 */
const nextPage = async (
  walk: SourceWalk,
  after: string | null,
): Promise<SafeId<"caseLawDecision">[]> => {
  const rows = await rootDb.transaction(
    async (tx) =>
      await tx
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.sourceId, walk.sourceId),
            carriesAbsentPublisherText(walk.markers),
            // Compared as SQL rather than through a typed column predicate:
            // the cursor is either an id this run already visited or the one an
            // operator passed to `--after`, and the cast is where a value that
            // is not an id fails loudly.
            ...(after === null
              ? []
              : [sql`${caseLawDecisions.id} > ${after}::uuid`]),
          ),
        )
        .orderBy(caseLawDecisions.id)
        .limit(PAGE),
  );
  return rows.map(({ id }) => id);
};

/**
 * Repair one decision and tell the projection, in one transaction.
 *
 * The row is re-read under the predicate rather than trusted from the page: a
 * decision the crawl re-observed in between already carries whatever the write
 * path allowed, and this run must not undo that.
 */
const repairDecision = async (
  walk: SourceWalk,
  entityId: SafeId<"caseLawDecision">,
): Promise<boolean> =>
  await rootDb.transaction(async (tx: Transaction) => {
    const lock = await lockActiveCorpusProjectionSourceByIdTx(tx, {
      family: "case_law",
      sourceId: walk.sourceId,
    });
    // audit: skip — operator repair of public case-law metadata; no user action
    const repaired = await tx
      .update(caseLawDecisions)
      .set({
        metadata: strippedPublisherMetadata(walk.markers),
        indexedHash: null,
      })
      .where(
        and(
          eq(caseLawDecisions.id, entityId),
          carriesAbsentPublisherText(walk.markers),
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

type WalkProgress = {
  /** Ids the walk has visited, repaired or not. */
  visited: number;
  /** Rows this walk actually changed. */
  repaired: number;
  /** Last id the walk accounted for, to resume after. */
  resumeAfter: string | null;
};

/**
 * Repair one page, id by id. Recursive rather than a loop: each decision is
 * its own transaction, and the next one may only start once the previous has
 * committed, so this is a walk rather than a fan-out.
 */
const repairPage = async (
  walk: SourceWalk,
  ids: readonly SafeId<"caseLawDecision">[],
  index: number,
  progress: WalkProgress,
  budget: number,
): Promise<WalkProgress> => {
  const entityId = ids.at(index);
  if (entityId === undefined || progress.repaired >= budget) {
    return progress;
  }
  const repaired = await repairDecision(walk, entityId);
  return await repairPage(
    walk,
    ids,
    index + 1,
    {
      visited: progress.visited + 1,
      repaired: progress.repaired + (repaired ? 1 : 0),
      resumeAfter: entityId,
    },
    budget,
  );
};

/** Page after page, from the cursor, until the source or the budget is done. */
const walkSource = async (
  walk: SourceWalk,
  progress: WalkProgress,
  budget: number,
): Promise<WalkProgress> => {
  if (progress.repaired >= budget) {
    return progress;
  }
  const ids = await nextPage(walk, progress.resumeAfter);
  if (ids.length === 0) {
    return progress;
  }
  const advanced = await repairPage(walk, ids, 0, progress, budget);
  if (advanced.visited === progress.visited) {
    return advanced;
  }
  return await walkSource(walk, advanced, budget);
};

/** Source after source, each its own walk, until the run's budget is spent. */
const walkSources = async (
  sources: readonly AffectedSource[],
  index: number,
  repaired: number,
): Promise<number> => {
  const source = sources.at(index);
  if (source === undefined || repaired >= limit) {
    return repaired;
  }
  const progress = await walkSource(
    {
      markers: absentTextComparisonsFor(source.adapter),
      sourceId: source.sourceId,
    },
    { visited: 0, repaired: 0, resumeAfter: resumeAfter ?? null },
    limit - repaired,
  );
  console.info(
    `${source.adapter.padEnd(14)} ${String(progress.repaired).padStart(9)} repaired, ` +
      `${String(progress.visited)} visited, resume after ${progress.resumeAfter ?? "<start>"}`,
  );
  return await walkSources(sources, index + 1, repaired + progress.repaired);
};

const affected = (await survey()).filter(
  ({ adapter }) => adapterFilter === undefined || adapter === adapterFilter,
);
const total = printSurvey(affected);

if (!apply) {
  console.info(
    "Report only: nothing written. Re-run with --apply to strip the markers " +
      "and re-enqueue the affected rows for projection.",
  );
  process.exit(0);
}

if (resumeAfter !== undefined && affected.length > 1) {
  console.error(
    "--after resumes one source's walk; name it with --adapter, because a " +
      "decision id orders rows within a source only.",
  );
  console.error(USAGE);
  process.exit(1);
}

const repaired = await walkSources(affected.toSorted(byAdapterKey), 0, 0);

console.info(
  `done: ${String(repaired)} rows repaired ` +
    `(survey reported ${String(total)} before the run).`,
);
console.info(
  "Both index paths are re-enqueued; they settle on their own schedules.",
);

// Re-surveyed rather than inferred from the count above: a run that hit
// `--limit`, or raced a crawl of a source deployed without the fix, has a count
// that says otherwise.
printSurvey(await survey());

process.exit(0);
