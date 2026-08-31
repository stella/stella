import { panic } from "better-result";
import { and, asc, eq, inArray, or } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

type CorpusProjectionRevisionTarget = {
  family: CorpusFamily;
  generation: string;
};

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
    .select({ projectionRevision: corpusIndexGenerations.projectionRevision })
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, target.family),
        eq(corpusIndexGenerations.generation, target.generation),
      ),
    )
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

/** Read the mutation clock without holding its row lock across engine I/O. */
export const readCorpusIndexProjectionRevisionTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<number> =>
  requireProjectionRevision(await projectionRevisionQuery(tx, target), target);

/**
 * Acquire generation mutation fences in one stable order before any projection
 * state or intent row is locked. Revision triggers then update rows already
 * owned by the transaction instead of attempting a deadlock-prone lock upgrade.
 */
export const lockCorpusIndexProjectionMutationsTx = async (
  tx: Transaction,
  targets: readonly CorpusProjectionRevisionTarget[],
): Promise<void> => {
  const ordered = uniqueOrderedTargets(targets);
  if (ordered.length === 0) {
    return panic("Corpus projection mutation requires a generation target");
  }
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
  const locked = await tx
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
    .limit(ordered.length)
    .for("update");
  if (
    locked.length !== ordered.length ||
    locked.some((target, index) => {
      const expected = ordered.at(index);
      return (
        expected === undefined || targetKey(target) !== targetKey(expected)
      );
    })
  ) {
    return panic("Corpus projection mutation generation is not registered");
  }
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
 * Fence a generation's desired/applied state at one exact mutation revision.
 * Projection-table statement triggers need an exclusive lock on this row, so
 * they cannot commit across a transaction that holds this proof through flip.
 */
export const lockCorpusIndexProjectionRevisionTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<number> =>
  requireProjectionRevision(
    await projectionRevisionQuery(tx, target).for("share"),
    target,
  );

/**
 * Serialize explicit promotion before its final proof and serving flip. This
 * avoids two operators taking shared proofs and deadlocking while both try to
 * upgrade the generation row for the transition.
 */
export const lockCorpusIndexProjectionPromotionTx = async (
  tx: Transaction,
  target: CorpusProjectionRevisionTarget,
): Promise<number> =>
  requireProjectionRevision(
    await projectionRevisionQuery(tx, target).for("update"),
    target,
  );
