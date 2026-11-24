import { panic, Result, TaggedError } from "better-result";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import { declareFingerprintFields } from "@stll/errors";

import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionRevisions,
} from "@/api/db/schema";
import type { Transaction } from "@/api/db/types";
import type { SafeId } from "@/api/lib/branded-types";
import { withAggregateSavepoint } from "@/api/lib/db/aggregate-lock";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { isPgError, PG_ERROR } from "@/api/lib/pg-error";

type CorpusProjectionRevisionTarget = {
  family: CorpusFamily;
  generation: string;
};

const CORPUS_PROJECTION_REVISION_PRUNE_LIMIT = 1000;

const targetKey = ({ family, generation }: CorpusProjectionRevisionTarget) =>
  `${family}/${generation}`;

const uniqueOrderedTargets = (
  targets: readonly CorpusProjectionRevisionTarget[],
): CorpusProjectionRevisionTarget[] => {
  const byKey = new Map(targets.map((target) => [targetKey(target), target]));
  return [...byKey.values()].toSorted((left, right) => {
    const leftKey = targetKey(left);
    const rightKey = targetKey(right);
    if (leftKey === rightKey) {
      return 0;
    }
    return leftKey < rightKey ? -1 : 1;
  });
};

const projectionRevisionQuery = (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
) =>
  tx
    .select({ projectionRevision: corpusIndexProjectionRevisions.revision })
    .from(corpusIndexProjectionRevisions)
    .where(
      and(
        eq(corpusIndexProjectionRevisions.family, target.family),
        eq(corpusIndexProjectionRevisions.generation, target.generation),
      ),
    )
    .orderBy(desc(corpusIndexProjectionRevisions.revision))
    .limit(1);

const requireProjectionRevision = (
  rows: { projectionRevision: number }[],
  target: CorpusProjectionRevisionTarget,
): number => {
  const revision = rows.at(0)?.projectionRevision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return panic(
      `Corpus projection revision is malformed: ${target.family}/${target.generation}`,
    );
  }
  return revision;
};

/** Read the latest committed mutation without holding a proof fence. */
export const readCorpusIndexProjectionRevisionTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<number> =>
  requireProjectionRevision(await projectionRevisionQuery(tx, target), target);

/** Join the database-enforced writer side of the projection mutation fence. */
export const lockCorpusIndexProjectionWriterTx = async (
  tx: Transaction,
): Promise<void> => {
  await tx.execute(
    sql`SELECT public.lock_corpus_projection_mutations_shared()`,
  );
};

/**
 * Join the shared mutation fence, then validate every target without locking
 * the generation registry. Projection-table triggers enforce the same fence
 * for writes that do not pass through this helper.
 */
export const lockCorpusIndexProjectionMutationsTx = async (
  tx: Transaction,
  targets: readonly CorpusProjectionRevisionTarget[],
): Promise<void> => {
  const ordered = uniqueOrderedTargets(targets);
  if (ordered.length === 0) {
    return panic("Corpus projection mutation requires a generation target");
  }
  await lockCorpusIndexProjectionWriterTx(tx);
  const predicate = or(
    ...ordered.map(({ family, generation }) =>
      and(
        eq(corpusIndexGenerations.family, family),
        eq(corpusIndexGenerations.generation, generation),
      ),
    ),
  );
  if (predicate === undefined) {
    return panic("Corpus projection mutation target predicate is empty");
  }
  const registered = await tx
    .select({
      family: corpusIndexGenerations.family,
      generation: corpusIndexGenerations.generation,
    })
    .from(corpusIndexGenerations)
    .where(predicate)
    .orderBy(
      asc(corpusIndexGenerations.family),
      asc(corpusIndexGenerations.generation),
    )
    .limit(ordered.length);
  if (
    registered.length !== ordered.length ||
    registered.some((target, index) => {
      const expected = ordered.at(index);
      return (
        expected === undefined || targetKey(target) !== targetKey(expected)
      );
    })
  ) {
    return panic("Corpus projection mutation generation is not registered");
  }
};

const pruneCorpusIndexProjectionRevisionsTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
  currentRevision: number,
): Promise<void> => {
  await tx.execute(sql`
    DELETE FROM ${corpusIndexProjectionRevisions} revision
    WHERE revision.ctid IN (
      SELECT candidate.ctid
      FROM ${corpusIndexProjectionRevisions} candidate
      WHERE candidate.family = ${target.family}
        AND candidate.generation = ${target.generation}
        AND candidate.revision < ${currentRevision}
      ORDER BY candidate.revision
      LIMIT ${CORPUS_PROJECTION_REVISION_PRUNE_LIMIT}
    )
  `);
};

/**
 * The exclusive side of the fence was not granted within the lock timeout
 * (the caller's own, or the database's bound when the caller set none):
 * writers are in flight. Nothing was taken and the caller's transaction is
 * still usable; retry when the projection is quieter.
 */
export class CorpusIndexProjectionFenceBusyError extends TaggedError(
  "CorpusIndexProjectionFenceBusyError",
)<{ message: string; reason: "lock_unavailable" }> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

/**
 * Take the exclusive side inside a savepoint, so a lock wait the database
 * gives up on (55P03) rolls back only the savepoint and becomes `busy`. A
 * granted transaction lock outlives the savepoint's release.
 */
const takeCorpusIndexProjectionExclusiveTx = async (
  tx: Transaction,
): Promise<Result<void, CorpusIndexProjectionFenceBusyError>> => {
  const taken = await Result.tryPromise({
    try: async () =>
      await withAggregateSavepoint(tx, async (savepoint: Transaction) => {
        await savepoint.execute(
          sql`SELECT public.lock_corpus_projection_mutations_exclusive()`,
        );
      }),
    catch: (cause) => cause,
  });
  if (taken.isOk()) {
    return Result.ok(undefined);
  }
  if (!isPgError(taken.error, PG_ERROR.LOCK_NOT_AVAILABLE)) {
    // Not a refusal of this lock. The database failure stays the cause, so
    // a caller still classifies it (a statement timeout, a deadlock).
    return panic("The exclusive projection mutation fence failed", taken.error);
  }
  return Result.err(
    new CorpusIndexProjectionFenceBusyError({
      message:
        "The exclusive projection mutation fence was not granted within the lock timeout; projection writers are in flight",
      reason: "lock_unavailable",
    }),
  );
};

const lockCorpusIndexProjectionExclusiveTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<Result<number, CorpusIndexProjectionFenceBusyError>> => {
  const taken = await takeCorpusIndexProjectionExclusiveTx(tx);
  if (taken.isErr()) {
    return Result.err(taken.error);
  }
  const revision = requireProjectionRevision(
    await projectionRevisionQuery(tx, target),
    target,
  );
  await pruneCorpusIndexProjectionRevisionsTx(tx, target, revision);
  return Result.ok(revision);
};

export const lockCorpusIndexProjectionIntentMutationsTx = async (
  tx: Transaction,
  intentIds: readonly SafeId<"corpusIndexProjectionIntent">[],
): Promise<void> => {
  const uniqueIds = new Set(intentIds);
  if (uniqueIds.size === 0 || uniqueIds.size !== intentIds.length) {
    return panic("Corpus projection mutation intent ids must be unique");
  }
  const identities = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.id, [...uniqueIds]));
  if (identities.length !== uniqueIds.size) {
    return panic("Corpus projection mutation intent identity changed");
  }
  await lockCorpusIndexProjectionMutationsTx(tx, identities);
};

/**
 * Fence desired/applied state at one exact mutation revision. The exclusive
 * transaction fence waits for every writer, at most one lock timeout (then
 * `busy`), and prevents a new projection mutation from committing across the
 * proof transaction.
 */
export const lockCorpusIndexProjectionRevisionTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<Result<number, CorpusIndexProjectionFenceBusyError>> =>
  await lockCorpusIndexProjectionExclusiveTx(tx, target);

/**
 * Hold the exclusive side of the mutation fence for a generation flip: every
 * in-flight projection writer has committed, and none can commit until this
 * transaction ends. Unlike the proof fences it reads and prunes nothing, so a
 * dry run of the flip takes it without writing. Writers that do not finish
 * within one lock timeout make it `busy`.
 */
export const lockCorpusIndexProjectionFlipTx = async (
  tx: Transaction,
): Promise<
  Result<CorpusIndexProjectionFlipFence, CorpusIndexProjectionFenceBusyError>
> => {
  const taken = await takeCorpusIndexProjectionExclusiveTx(tx);
  if (taken.isErr()) {
    return Result.err(taken.error);
  }
  return Result.ok({ [FLIP_FENCE]: true });
};

const FLIP_FENCE = Symbol("corpus-index-projection-flip-fence");

/**
 * Proof that the transaction holds the exclusive mutation fence
 * (`lockCorpusIndexProjectionFlipTx` is its only maker): no projection state,
 * intent or registry status can change until it ends, so a read that takes
 * it needs no row lock of its own.
 */
export type CorpusIndexProjectionFlipFence = { readonly [FLIP_FENCE]: true };

/**
 * Serialize explicit promotion before its final proof and serving flip;
 * `busy` when writers do not finish within one lock timeout.
 */
export const lockCorpusIndexProjectionPromotionTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<Result<number, CorpusIndexProjectionFenceBusyError>> =>
  await lockCorpusIndexProjectionExclusiveTx(tx, target);
