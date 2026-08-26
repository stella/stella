import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { corpusIndexGenerations } from "@/api/db/schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";

type CorpusProjectionRevisionTarget = {
  family: CorpusFamily;
  generation: string;
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
