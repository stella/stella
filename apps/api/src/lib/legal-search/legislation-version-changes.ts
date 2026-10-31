import { panic, Result, TaggedError } from "better-result";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import * as v from "valibot";

import { isEligibleLegislationExpression } from "@stll/api-contract/legislation-expression";
import {
  STATUTE_VERSION_CHANGES_METHOD,
  storedStatuteVersionChangesSchema,
} from "@stll/api-contract/statute-version-changes";
import type { StoredStatuteVersionChanges } from "@stll/api-contract/statute-version-changes";
import { compareCodeUnit } from "@stll/collation";
import { chunk } from "@stll/concurrency/chunk";
import {
  compareStatuteBlocks,
  countStatuteChanges,
} from "@stll/legal-ast/statute-compare";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  eligibleExpression,
  isDated,
  legislationVersionRef,
  precedesInHistory,
} from "@/api/lib/legal-search/legislation-validity-window";
import {
  readVersionChangePayloads,
  VERSION_CHANGE_COMPARISON_BATCH_MAX,
} from "@/api/lib/legal-search/legislation-version-blocks";
import type { VersionChangePayload } from "@/api/lib/legal-search/legislation-version-blocks";

/**
 * What each consolidation of a Work changed against the eligible
 * consolidation before it, stored on the version row (`change_summary`).
 *
 * The counts come from `countStatuteChanges`, over the comparison the reader
 * draws side by side, so a version list and the comparison it opens cannot
 * disagree. They are computed here, from the stored ASTs, and never by a
 * reader downloading every version.
 *
 * Every summary names the payload revisions of both versions it was computed
 * from. A summary is fresh while those still hold and the version before is
 * still the same one; otherwise it is recomputed. Ingestion refreshes the
 * version it stored and the one after it; the backfill walks every Work.
 * Both use `refreshWorkVersionChanges`, and its write is a compare-and-set,
 * so a run that loses a race to a newer write leaves the newer summary.
 */

/** Maximum metadata rows transferred while planning one work page. */
const VERSION_CHANGE_HISTORY_BATCH_MAX = 10_000;

/** The version identity the summaries are kept within. */
export type LegislationVersionWork = {
  sourceId: SafeId<"legislationSource">;
  eli: string;
  language: string;
};

/** One dated version of a Work, as the planner reads it. */
export type VersionChangeCandidate = {
  id: SafeId<"legislationDocument">;
  versionValidFrom: string;
  payloadRevision: bigint;
  eligible: boolean;
  /** The stored `change_summary`, unparsed. */
  changeSummary: unknown;
};

/** A version whose summary is missing or stale, and the version before it. */
type VersionChangeTask = {
  target: VersionChangeCandidate;
  base: VersionChangeCandidate | null;
};

/** The order the corpus walks a Work's windows in: opening day, then id. */
const byOpening = (
  left: VersionChangeCandidate,
  right: VersionChangeCandidate,
): number =>
  compareCodeUnit(left.versionValidFrom, right.versionValidFrom) ||
  compareCodeUnit(left.id, right.id);

/** A payload revision as a summary stores it: a JSON number. */
const storedRevision = (revision: bigint): number => {
  const value = Number(revision);
  return Number.isSafeInteger(value)
    ? value
    : panic("Legislation payload revision exceeds a safe integer");
};

/** Whether the stored summary was computed from exactly this pair. */
export const isVersionChangeSummaryFresh = ({
  base,
  target,
}: VersionChangeTask): boolean => {
  const parsed = v.safeParse(
    storedStatuteVersionChangesSchema,
    target.changeSummary,
  );
  if (!parsed.success) {
    return false;
  }
  const stored = parsed.output;
  if (
    stored.method !== STATUTE_VERSION_CHANGES_METHOD ||
    BigInt(stored.payloadRevision) !== target.payloadRevision
  ) {
    return false;
  }
  if (base === null) {
    return stored.type === "first";
  }
  return (
    stored.type !== "first" &&
    stored.base.documentId === base.id &&
    BigInt(stored.base.payloadRevision) === base.payloadRevision
  );
};

/**
 * Which versions a write of `around` can have outdated: itself (its text or
 * its window changed) and the first eligible version after it (its base may
 * now be `around`, or no longer be). Every version when nothing was written.
 */
const scopeAround = (
  ordered: readonly VersionChangeCandidate[],
  around: SafeId<"legislationDocument"> | undefined,
): ((version: VersionChangeCandidate) => boolean) => {
  if (around === undefined) {
    return () => true;
  }
  const index = ordered.findIndex((version) => version.id === around);
  const next = ordered.slice(index + 1).find((version) => version.eligible);
  const scope = new Set(
    index === -1 ? [] : [around, ...(next === undefined ? [] : [next.id])],
  );
  return (version) => scope.has(version.id);
};

type PlanVersionChangesOptions = {
  versions: readonly VersionChangeCandidate[];
  /**
   * Only the summaries one stored version can have outdated: its own, and
   * that of the eligible version after it. Omitted, every version is planned.
   */
  around?: SafeId<"legislationDocument"> | undefined;
};

/**
 * The summaries of one Work that need computing, oldest first. Only an
 * eligible version is summarised, and only against an eligible one: a
 * version that never applied is history in the list, never a step of it.
 */
export const planVersionChanges = ({
  around,
  versions,
}: PlanVersionChangesOptions): VersionChangeTask[] => {
  const ordered = versions.toSorted(byOpening);
  const inScope = scopeAround(ordered, around);
  const tasks: VersionChangeTask[] = [];
  let previous: VersionChangeCandidate | null = null;

  for (const version of ordered) {
    if (!version.eligible) {
      continue;
    }
    const task = { target: version, base: previous };
    previous = version;
    if (inScope(version) && !isVersionChangeSummaryFresh(task)) {
      tasks.push(task);
    }
  }

  return tasks;
};

type ComputedSummary = {
  summary: StoredStatuteVersionChanges;
  base: { id: SafeId<"legislationDocument">; payloadRevision: bigint } | null;
};

/**
 * The summary of one task, from the versions as they are stored now. The
 * revisions recorded are the ones read with the text, so a write that
 * lands between planning and reading is either what was compared or what
 * makes the write below refuse.
 */
const computeSummary = (
  payloads: ReadonlyMap<SafeId<"legislationDocument">, VersionChangePayload>,
  { base, target }: VersionChangeTask,
): ComputedSummary | null => {
  const newer = payloads.get(target.id);
  if (newer === undefined) {
    return null;
  }
  const provenance = {
    method: STATUTE_VERSION_CHANGES_METHOD,
    payloadRevision: storedRevision(newer.payloadRevision),
  };
  if (base === null) {
    return { summary: { type: "first", ...provenance }, base: null };
  }
  const older = payloads.get(base.id);
  if (older === undefined) {
    return null;
  }
  const baseRef = {
    documentId: base.id,
    payloadRevision: storedRevision(older.payloadRevision),
  };
  const computedBase = { id: base.id, payloadRevision: older.payloadRevision };
  const notCompared = (
    reason: "no-blocks" | "unreadable" | "comparison-failed",
  ): ComputedSummary => ({
    summary: { type: "not-compared", ...provenance, base: baseRef, reason },
    base: computedBase,
  });

  if (older.type === "unreadable" || newer.type === "unreadable") {
    return notCompared("unreadable");
  }
  if (older.type === "no-blocks" || newer.type === "no-blocks") {
    return notCompared("no-blocks");
  }
  const rows = compareStatuteBlocks({
    older: older.blocks,
    newer: newer.blocks,
  });
  if (Result.isError(rows)) {
    return notCompared("comparison-failed");
  }
  return {
    summary: {
      type: "compared",
      ...provenance,
      base: baseRef,
      counts: countStatuteChanges(rows.value),
    },
    base: computedBase,
  };
};

/**
 * The eligible version a row's window follows, as SQL over the row being
 * written: the same rule `planVersionChanges` applies, so the write can
 * check it still holds.
 */
const predecessorIdOf = (tx: Transaction): SQL => {
  const previous = alias(legislationDocuments, "previous");
  const predecessor = tx
    .select({ id: previous.id })
    .from(previous)
    .where(
      and(
        eq(previous.sourceId, legislationDocuments.sourceId),
        eq(previous.eli, legislationDocuments.eli),
        eq(previous.language, legislationDocuments.language),
        isDated(legislationVersionRef(previous)),
        eligibleExpression(legislationVersionRef(previous)),
        precedesInHistory(
          { ref: legislationVersionRef(previous), id: previous.id },
          {
            ref: legislationVersionRef(legislationDocuments),
            id: legislationDocuments.id,
          },
        ),
      ),
    )
    .orderBy(desc(previous.versionValidFrom), desc(previous.id))
    .limit(1);
  return sql`(${predecessor})`;
};

/** Work keys are shared by candidate grouping and page planning. */
export const versionChangeWorkKey = ({
  sourceId,
  eli,
  language,
}: LegislationVersionWork) => JSON.stringify([sourceId, eli, language]);

const SUMMARY_WRITE_BATCH_MAX = 100;

class VersionChangeReadLimitError extends TaggedError(
  "VersionChangeReadLimitError",
)<{
  message: string;
  cap: number;
}> {}

type PlanVersionChangeTasksOptions = {
  db: ScopedDb;
  works: readonly LegislationVersionWork[];
  around?: SafeId<"legislationDocument"> | undefined;
};

export type WorkVersionChangeTask = VersionChangeTask & {
  work: LegislationVersionWork;
};

type PlanVersionChangeTasksResult = Result<
  WorkVersionChangeTask[],
  VersionChangeReadLimitError
>;

/** Read one bounded history batch, refusing a truncated predecessor sequence. */
export const planVersionChangeTasks = async ({
  db,
  works,
  around,
}: PlanVersionChangeTasksOptions): Promise<PlanVersionChangeTasksResult> => {
  if (works.length === 0) {
    return Result.ok([]);
  }
  const result = await db(
    async (tx) =>
      await readBounded(
        tx
          .select({
            sourceId: legislationDocuments.sourceId,
            eli: legislationDocuments.eli,
            language: legislationDocuments.language,
            id: legislationDocuments.id,
            versionValidFrom: legislationDocuments.versionValidFrom,
            payloadRevision: legislationDocuments.payloadRevision,
            expressionKind: legislationDocuments.expressionKind,
            windowDisposition: legislationDocuments.windowDisposition,
            changeSummary: legislationDocuments.changeSummary,
          })
          .from(legislationDocuments)
          .where(
            and(
              or(
                ...works.map((work) =>
                  and(
                    eq(legislationDocuments.sourceId, work.sourceId),
                    eq(legislationDocuments.eli, work.eli),
                    eq(legislationDocuments.language, work.language),
                  ),
                ),
              ),
              isDated(legislationVersionRef(legislationDocuments)),
            ),
          )
          .orderBy(
            asc(legislationDocuments.sourceId),
            asc(legislationDocuments.eli),
            asc(legislationDocuments.language),
            asc(legislationDocuments.versionValidFrom),
            asc(legislationDocuments.id),
          ),
        VERSION_CHANGE_HISTORY_BATCH_MAX,
      ),
  );
  if (result.type === "overflow") {
    return Result.err(
      new VersionChangeReadLimitError({
        message:
          "Version histories exceed the comparison batch bound; use a smaller work page",
        cap: result.cap,
      }),
    );
  }
  const grouped = new Map<string, VersionChangeCandidate[]>();
  for (const work of works) {
    grouped.set(versionChangeWorkKey(work), []);
  }
  for (const row of result.rows) {
    const versions = grouped.get(versionChangeWorkKey(row));
    if (versions === undefined || row.versionValidFrom === null) {
      panic(
        "Version history query returned a row outside its work/date boundary",
      );
    }
    versions.push({
      id: row.id,
      versionValidFrom: row.versionValidFrom,
      payloadRevision: row.payloadRevision,
      eligible: isEligibleLegislationExpression(row),
      changeSummary: row.changeSummary,
    });
  }
  return Result.ok(
    works.flatMap((work) => {
      const versions = grouped.get(versionChangeWorkKey(work));
      if (versions === undefined) {
        return panic("Version history batch omitted a requested work");
      }
      return planVersionChanges({ versions, around }).map((task) => ({
        ...task,
        work,
      }));
    }),
  );
};

export type PreparedVersionChange = ComputedSummary & {
  targetId: SafeId<"legislationDocument">;
  work: LegislationVersionWork;
};

type PrepareVersionChangesOptions = {
  db: ScopedDb;
  tasks: readonly WorkVersionChangeTask[];
  readPayloads?: typeof readVersionChangePayloads | undefined;
};

/** Payloads are read outside write transactions and released after each bounded comparison batch. */
export const prepareVersionChanges = async ({
  db,
  tasks,
  readPayloads = readVersionChangePayloads,
}: PrepareVersionChangesOptions) => {
  const writes: PreparedVersionChange[] = [];
  for (const batch of chunk(tasks, VERSION_CHANGE_COMPARISON_BATCH_MAX)) {
    const ids = [
      ...new Set(
        batch.flatMap(({ target, base }) =>
          base === null ? [target.id] : [target.id, base.id],
        ),
      ),
    ];
    const payloadRead = await readPayloads({ db, ids });
    if (payloadRead.isErr()) {
      return Result.err(payloadRead.error);
    }
    const payloads = payloadRead.value;
    for (const task of batch) {
      const computed = computeSummary(payloads, task);
      if (computed !== null) {
        writes.push({
          ...computed,
          targetId: task.target.id,
          work: task.work,
        });
      }
    }
  }
  return Result.ok(writes);
};

/** Each row checks both payload revisions and its current predecessor in the same batched statement. */
export const writePreparedVersionChangesTx = async (
  tx: Transaction,
  writes: readonly PreparedVersionChange[],
): Promise<number> => {
  let written = 0;
  for (const batch of chunk(writes, SUMMARY_WRITE_BATCH_MAX)) {
    const values = batch.map(
      ({ targetId, base, summary }) =>
        sql`(${targetId}::uuid, ${summary.payloadRevision}::bigint, ${base?.id ?? null}::uuid, ${base?.payloadRevision ?? null}::bigint, ${JSON.stringify(summary)}::text::jsonb)`,
    );
    const current = alias(legislationDocuments, "current_base");
    const predecessor = predecessorIdOf(tx);
    // Keep the scalar bigint expression; a row projection encodes it as text.
    const baseRevision = tx
      .select({ revision: sql`${current.payloadRevision}` })
      .from(current)
      .where(eq(current.id, sql`batch.base_id`))
      .limit(1);
    // audit: skip — derived public legislation state; no user action
    const changed = await tx
      .update(legislationDocuments)
      .set({
        changeSummary: sql`batch.summary`,
        updatedAt: sql`${legislationDocuments.updatedAt}`,
      })
      .from(
        sql`(VALUES ${sql.join(values, sql`, `)}) AS batch(target_id, target_revision, base_id, base_revision, summary)`,
      )
      .where(
        and(
          eq(legislationDocuments.id, sql`batch.target_id`),
          eq(legislationDocuments.payloadRevision, sql`batch.target_revision`),
          sql`${predecessor} IS NOT DISTINCT FROM batch.base_id`,
          sql`(${baseRevision}) IS NOT DISTINCT FROM batch.base_revision`,
        ),
      )
      .returning({ id: legislationDocuments.id });
    written += changed.length;
  }
  return written;
};

type RefreshWorkVersionChangesOptions = {
  db: ScopedDb;
  work: LegislationVersionWork;
  around?: SafeId<"legislationDocument"> | undefined;
  readPayloads?: typeof readVersionChangePayloads | undefined;
};

/** Refresh the same canonical comparison plan used by the backfill. */
export const refreshWorkVersionChanges = async ({
  db,
  work,
  around,
  readPayloads,
}: RefreshWorkVersionChangesOptions) => {
  const taskPlan = await planVersionChangeTasks({
    db,
    works: [work],
    around,
  });
  if (taskPlan.isErr()) {
    return Result.err(taskPlan.error);
  }
  const tasks = taskPlan.value;
  const preparation = await prepareVersionChanges({
    db,
    tasks,
    readPayloads,
  });
  if (preparation.isErr()) {
    return Result.err(preparation.error);
  }
  const writes = preparation.value;
  const written = await db(
    async (tx) => await writePreparedVersionChangesTx(tx, writes),
  );
  return Result.ok({
    planned: tasks.length,
    written,
    superseded: tasks.length - written,
  });
};
