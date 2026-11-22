import { panic } from "better-result";
import { and, asc, eq, or, type SQL, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { lockCorpusProjectionRevisionsAfterStates } from "@/api/lib/db/aggregate-lock";
import { transitionBatch } from "@/api/lib/db/transitions";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { CORPUS_INDEX_PROJECTION_INTENT_LIFECYCLE } from "@/api/lib/legal-search/corpus-index-projection-intent-transition-spec";
import {
  corpusIndexProjectionRevisionIsRestorable,
  corpusIndexProjectionStateServesRevision,
} from "@/api/lib/legal-search/corpus-index-projection-sql";

/**
 * The one transition that returns a served `cleanup_pending` revision to
 * `applied`, shared by its two callers: the cleanup claim's restore branch and
 * the repair writer, which restores a queued copy before a repair would cost
 * it its proof (`writeRepairedCorpusProjectionDesiredStatesTx`). The
 * ownership registry confines this module to them.
 */

type ProjectionIntentId = SafeId<"corpusIndexProjectionIntent">;

type RestoreServedRevisionsOptions = {
  intentIds: readonly ProjectionIntentId[];
  transitionAt: Date | SQL<Date>;
};

/**
 * Return served revisions no delete reached to `applied`. The caller decided
 * each one under its state's and its own row lock. The columns are the ones
 * the revision held while applied: preparation only queued it, and the
 * publish barrier and every append instant are immutable. The database guard
 * on `cleanup_pending -> applied` repeats the restore predicate.
 */
export const restoreServedCorpusProjectionRevisionsTx = async (
  tx: Transaction,
  { intentIds, transitionAt }: RestoreServedRevisionsOptions,
): Promise<void> => {
  if (intentIds.length === 0) {
    return;
  }
  const restored = await transitionBatch({
    tx,
    spec: CORPUS_INDEX_PROJECTION_INTENT_LIFECYCLE,
    ids: intentIds,
    options: {
      to: "applied",
      from: ["cleanup_pending"],
      set: {
        leaseToken: null,
        leaseExpiresAt: null,
        cleanupNotBefore: null,
        lastError: null,
        updatedAt: transitionAt,
      },
    },
    // Bookkeeping on the derived public corpus projection: no tenant data
    // and no actor; each caller reports its restores.
    recordTransitionAuditEvent: () => undefined,
  });
  if (restored.length !== intentIds.length) {
    return panic(
      `Corpus projection restored ${restored.length} of ${intentIds.length} revisions`,
    );
  }
};

/** A named copy queued for cleanup, as the repair writer found it. */
type CorpusProjectionQueuedNamedCopy = {
  family: CorpusFamily;
  generation: string;
  entityId: string;
  revisionId: ProjectionIntentId;
};

const NAMED_COPY_DECISIONS = ["restore", "already_current", "held"] as const;
type NamedCopyDecision = (typeof NAMED_COPY_DECISIONS)[number];

/** What became of one queued copy the repair writer re-read. */
type CorpusProjectionQueuedCopyOutcome =
  "restored" | Exclude<NamedCopyDecision, "restore">;

const requireNamedCopyDecision = (value: unknown): NamedCopyDecision =>
  NAMED_COPY_DECISIONS.find((decision) => decision === value) ??
  panic(`Unknown named copy decision: ${String(value)}`);

/**
 * Restore the queued copies a repair found still restorable, before the
 * repair moves any epoch. Each copy is re-read under its revision's row lock
 * (the caller holds its state row, the projection lock order) and restored
 * only when its state still names that same revision as an upsert copy and
 * the revision is still provably the copy readers are served
 * (`corpusIndexProjectionRevisionIsRestorable`): never claimed, queued by
 * replacement preparation, applied at its own epoch, and either one desired
 * change behind or holding exactly the desired content. Pointer, revision
 * content and the physical copy are unchanged.
 *
 * Each copy comes back as `restored`, `already_current` (its revision is
 * `applied` and still named, so nothing was needed) or `held` (anything
 * else: a claim took it, a delete may have reached it, the state names
 * another revision or none). Held copies are left exactly as they were.
 */
export const restoreQueuedNamedCopiesTx = async (
  tx: Transaction,
  copies: readonly CorpusProjectionQueuedNamedCopy[],
): Promise<
  {
    copy: CorpusProjectionQueuedNamedCopy;
    outcome: CorpusProjectionQueuedCopyOutcome;
  }[]
> => {
  if (copies.length === 0) {
    return [];
  }
  const states = corpusIndexProjectionStates;
  const intents = corpusIndexProjectionIntents;
  await lockCorpusProjectionRevisionsAfterStates(
    tx,
    copies.map(({ revisionId }) => revisionId),
  );
  const served = {
    revisionId: intents.id,
    appliedRevision: states.appliedRevision,
    desiredAction: states.desiredAction,
    appliedAction: states.appliedAction,
  };
  const rows = await tx
    .select({
      revisionId: intents.id,
      entityId: states.entityId,
      generation: states.generation,
      decision: sql<string>`CASE
        WHEN ${corpusIndexProjectionStateServesRevision(served)} IS NOT TRUE
          THEN ${"held" satisfies NamedCopyDecision}
        WHEN ${intents.status} = 'applied'
          THEN ${"already_current" satisfies NamedCopyDecision}
        WHEN ${intents.status} = 'cleanup_pending'
          AND ${corpusIndexProjectionRevisionIsRestorable({
            ...served,
            revisionEpoch: intents.epoch,
            revisionFingerprint: intents.fingerprint,
            revisionIndexId: intents.indexId,
            cleanupAttempts: intents.cleanupAttempts,
            revisionAppliedAt: intents.appliedAt,
            lastError: intents.lastError,
            appliedEpoch: states.appliedEpoch,
            desiredEpoch: states.desiredEpoch,
            desiredFingerprint: states.desiredFingerprint,
            desiredIndexId: states.desiredIndexId,
          })}
          THEN ${"restore" satisfies NamedCopyDecision}
        ELSE ${"held" satisfies NamedCopyDecision}
      END`,
    })
    .from(intents)
    .innerJoin(
      states,
      and(
        eq(states.family, intents.family),
        eq(states.generation, intents.generation),
        eq(states.entityId, intents.entityId),
      ),
    )
    .where(
      or(
        ...copies.map(({ family, generation, entityId, revisionId }) =>
          and(
            eq(intents.id, revisionId),
            eq(states.family, family),
            eq(states.generation, generation),
            eq(states.entityId, entityId),
          ),
        ),
      ),
    )
    .orderBy(asc(intents.id))
    .limit(copies.length);
  const decided = new Map(
    rows.map((row) => [
      `${row.revisionId}/${row.generation}/${row.entityId}`,
      requireNamedCopyDecision(row.decision),
    ]),
  );
  const outcomes = copies.map((copy) => {
    // A revision or state that is gone is not explained by anything this
    // writer knows: hold it.
    const decision =
      decided.get(`${copy.revisionId}/${copy.generation}/${copy.entityId}`) ??
      "held";
    return { copy, decision };
  });
  await restoreServedCorpusProjectionRevisionsTx(tx, {
    intentIds: outcomes.flatMap(({ copy, decision }) =>
      decision === "restore" ? [copy.revisionId] : [],
    ),
    transitionAt: sql<Date>`clock_timestamp()`,
  });
  return outcomes.map(({ copy, decision }) => ({
    copy,
    outcome: decision === "restore" ? "restored" : decision,
  }));
};
