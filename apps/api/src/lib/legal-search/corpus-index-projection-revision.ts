import { panic } from "better-result";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionRevisions,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

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

const lockCorpusIndexProjectionExclusiveTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<number> => {
  await tx.execute(
    sql`SELECT public.lock_corpus_projection_mutations_exclusive()`,
  );
  const revision = requireProjectionRevision(
    await projectionRevisionQuery(tx, target),
    target,
  );
  await pruneCorpusIndexProjectionRevisionsTx(tx, target, revision);
  return revision;
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
 * transaction fence waits for every writer and prevents a new projection
 * mutation from committing across the proof transaction.
 */
export const lockCorpusIndexProjectionRevisionTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<number> => await lockCorpusIndexProjectionExclusiveTx(tx, target);

/**
 * Serialize explicit promotion before its final proof and serving flip.
 */
export const lockCorpusIndexProjectionPromotionTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<number> => await lockCorpusIndexProjectionExclusiveTx(tx, target);
