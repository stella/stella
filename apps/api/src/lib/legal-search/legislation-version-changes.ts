import { panic, Result } from "better-result";
import { and, asc, desc, eq, exists, sql } from "drizzle-orm";
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
import type { Block } from "@stll/legal-ast/document-ast";
import {
  compareStatuteBlocks,
  countStatuteChanges,
} from "@stll/legal-ast/statute-compare";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { parsePersistedCorpusAst } from "@/api/lib/legal-search/corpus-storage";
import {
  eligibleExpression,
  isDated,
  legislationVersionRef,
  precedesInHistory,
} from "@/api/lib/legal-search/legislation-validity-window";

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

/** More versions than any Work's history holds; see `readWorkVersionCandidatesTx`. */
const WORK_VERSIONS_MAX = 10_000;

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

/** One version's text as the comparison reads it. */
type VersionBlocks =
  | { type: "blocks"; blocks: readonly Block[]; payloadRevision: bigint }
  | { type: "no-blocks"; payloadRevision: bigint }
  | { type: "unreadable"; payloadRevision: bigint }
  | { type: "missing" };

const readVersionBlocksTx = async (
  tx: Transaction,
  id: SafeId<"legislationDocument">,
): Promise<VersionBlocks> => {
  const row = (
    await tx
      .select({
        documentAst: legislationDocuments.documentAst,
        payloadRevision: legislationDocuments.payloadRevision,
      })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, id))
      .limit(1)
  ).at(0);
  if (row === undefined) {
    return { type: "missing" };
  }
  const { payloadRevision } = row;
  const ast = Result.try(() => parsePersistedCorpusAst(row.documentAst));
  if (Result.isError(ast)) {
    return { type: "unreadable", payloadRevision };
  }
  const blocks =
    ast.value !== null && "blocks" in ast.value ? ast.value.blocks : [];
  return blocks.length === 0
    ? { type: "no-blocks", payloadRevision }
    : { type: "blocks", blocks, payloadRevision };
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
const computeSummary = async (
  db: ScopedDb,
  { base, target }: VersionChangeTask,
): Promise<ComputedSummary | null> => {
  const newer = await db(
    async (tx) => await readVersionBlocksTx(tx, target.id),
  );
  if (newer.type === "missing") {
    return null;
  }
  const provenance = {
    method: STATUTE_VERSION_CHANGES_METHOD,
    payloadRevision: storedRevision(newer.payloadRevision),
  };
  if (base === null) {
    return { summary: { type: "first", ...provenance }, base: null };
  }
  const older = await db(async (tx) => await readVersionBlocksTx(tx, base.id));
  if (older.type === "missing") {
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

/**
 * Store a summary only while both versions still hold the revisions it was
 * computed from and the version before is still its base. Returns whether it
 * was written; a refusal means a newer write owns the row's summary.
 */
const writeSummaryTx = async (
  tx: Transaction,
  target: SafeId<"legislationDocument">,
  { base, summary }: ComputedSummary,
): Promise<boolean> => {
  const current = alias(legislationDocuments, "current_base");
  const baseHolds =
    base === null
      ? sql`${predecessorIdOf(tx)} IS NULL`
      : and(
          sql`${predecessorIdOf(tx)} = ${base.id}`,
          exists(
            tx
              .select({ id: current.id })
              .from(current)
              .where(
                and(
                  eq(current.id, base.id),
                  eq(current.payloadRevision, base.payloadRevision),
                ),
              ),
          ),
        );
  // audit: skip — derived corpus state computed from public legislation; no user action
  const written = await tx
    .update(legislationDocuments)
    .set({
      changeSummary: summary,
      // Derived from the payload, not a change to it: the version's own
      // modification time (and the sitemap's lastmod) stay where they are.
      updatedAt: sql`${legislationDocuments.updatedAt}`,
    })
    .where(
      and(
        eq(legislationDocuments.id, target),
        eq(
          legislationDocuments.payloadRevision,
          BigInt(summary.payloadRevision),
        ),
        baseHolds,
      ),
    )
    .returning({ id: legislationDocuments.id });
  return written.length > 0;
};

/** One Work's dated versions, as the planner reads them. */
export const readWorkVersionCandidatesTx = async (
  tx: Transaction,
  work: LegislationVersionWork,
): Promise<VersionChangeCandidate[]> => {
  const rows = await tx
    .select({
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
        eq(legislationDocuments.sourceId, work.sourceId),
        eq(legislationDocuments.eli, work.eli),
        eq(legislationDocuments.language, work.language),
        isDated(legislationVersionRef(legislationDocuments)),
      ),
    )
    .orderBy(
      asc(legislationDocuments.versionValidFrom),
      asc(legislationDocuments.id),
    )
    // One Work's versions: a bound far above any act's history, so a
    // malformed source cannot make one refresh read without end.
    .limit(WORK_VERSIONS_MAX);
  return rows.flatMap((row) =>
    row.versionValidFrom === null
      ? []
      : [
          {
            id: row.id,
            versionValidFrom: row.versionValidFrom,
            payloadRevision: row.payloadRevision,
            eligible: isEligibleLegislationExpression(row),
            changeSummary: row.changeSummary,
          },
        ],
  );
};

type VersionChangeRefresh = {
  /** Summaries found missing or stale. */
  planned: number;
  /** Summaries written. */
  written: number;
  /** Summaries a newer write made obsolete before this one could land. */
  superseded: number;
};

type RefreshWorkVersionChangesOptions = {
  /**
   * Runs each step. Ingestion passes its scoped database, so each read and
   * write is its own short transaction; the backfill passes its batch
   * transaction.
   */
  db: ScopedDb;
  work: LegislationVersionWork;
  /** See `planVersionChanges`. */
  around?: SafeId<"legislationDocument"> | undefined;
};

/**
 * Bring a Work's change summaries up to its stored versions. Idempotent: a
 * Work whose summaries are fresh plans nothing and writes nothing, so a
 * repeated run converges without recomputing.
 */
export const refreshWorkVersionChanges = async ({
  around,
  db,
  work,
}: RefreshWorkVersionChangesOptions): Promise<VersionChangeRefresh> => {
  const versions = await db(
    async (tx) => await readWorkVersionCandidatesTx(tx, work),
  );
  const tasks = planVersionChanges({ versions, around });
  let written = 0;
  let superseded = 0;

  for (const task of tasks) {
    const computed = await computeSummary(db, task);
    const stored =
      computed !== null &&
      (await db(
        async (tx) => await writeSummaryTx(tx, task.target.id, computed),
      ));
    if (stored) {
      written += 1;
    } else {
      superseded += 1;
    }
  }

  return { planned: tasks.length, written, superseded };
};
