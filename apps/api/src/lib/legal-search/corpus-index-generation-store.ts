import { panic } from "better-result";
import { and, eq, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationSources,
} from "@/api/db/schema";
import {
  corpusIndexClusterForGeneration,
  type CorpusFamily,
  type QuickwitCluster,
} from "@/api/lib/legal-search/corpus-generation-contract";
import {
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { isRecord } from "@/api/lib/type-guards";

type GenerationTargetFor<TManifest extends CorpusIndexManifest> =
  TManifest extends CorpusIndexManifest
    ? Pick<TManifest, "family" | "generation">
    : never;

export type CorpusIndexGenerationTarget =
  GenerationTargetFor<CorpusIndexManifest>;

export type ServingCorpusIndexGeneration = {
  family: CorpusFamily;
  generation: string;
  cluster: QuickwitCluster;
};

/**
 * Fence activation against canonical writers. Writers share-lock their source
 * before checking the registry; the short table fence also covers a source
 * inserted concurrently with first activation.
 */
const lockCorpusIndexGenerationActivationTx = async (
  tx: Transaction,
  family: CorpusFamily,
): Promise<void> => {
  switch (family) {
    case "case_law":
      await tx.execute(sql`LOCK TABLE ${caseLawSources} IN EXCLUSIVE MODE`);
      return;
    case "legislation":
      await tx.execute(sql`LOCK TABLE ${legislationSources} IN EXCLUSIVE MODE`);
      return;
    default:
      return family satisfies never;
  }
};

type CorpusIndexGenerationReadTransaction = Pick<Transaction, "select">;
type CorpusIndexGenerationRow = typeof corpusIndexGenerations.$inferSelect;
type CorpusIndexGenerationContractRow = Pick<
  CorpusIndexGenerationRow,
  "cluster" | "family" | "generation" | "manifestDigest" | "status"
>;

export const requireRegisteredCorpusIndexManifest = ({
  family,
  generation,
  cluster,
  manifestDigest,
}: CorpusIndexGenerationContractRow): CorpusIndexManifest => {
  const manifest = requireCorpusIndexManifest(family, generation);
  const expectedDigest = corpusIndexManifestDigest(manifest);
  if (cluster !== manifest.cluster || manifestDigest !== expectedDigest) {
    return panic(
      `Corpus generation contract mismatch: ${family}/${generation}`,
    );
  }
  return manifest;
};

const requireServingCorpusIndexGeneration = (
  row: CorpusIndexGenerationContractRow,
  family: CorpusFamily,
): ServingCorpusIndexGeneration => {
  if (row.family !== family || row.status !== "serving") {
    return panic(`Serving corpus generation row is malformed: ${family}`);
  }
  const expectedCluster = corpusIndexClusterForGeneration(
    family,
    row.generation,
  );
  if (row.cluster !== expectedCluster) {
    return panic(
      `Serving corpus generation cluster mismatch: ${family}/${row.generation}`,
    );
  }
  if (row.cluster === "q09") {
    requireRegisteredCorpusIndexManifest(row);
  }
  return {
    family,
    generation: row.generation,
    cluster: row.cluster,
  };
};

/** Read the one database-authoritative generation and closed cluster route. */
export const readServingCorpusIndexGenerationTx = async (
  tx: CorpusIndexGenerationReadTransaction,
  family: CorpusFamily,
): Promise<ServingCorpusIndexGeneration> => {
  const rows = await tx
    .select({
      cluster: corpusIndexGenerations.cluster,
      family: corpusIndexGenerations.family,
      generation: corpusIndexGenerations.generation,
      manifestDigest: corpusIndexGenerations.manifestDigest,
      status: corpusIndexGenerations.status,
    })
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, family),
        eq(corpusIndexGenerations.status, "serving"),
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    return panic(`Expected one serving corpus generation: ${family}`);
  }
  return requireServingCorpusIndexGeneration(
    rows.at(0) ?? panic(`Serving corpus generation disappeared: ${family}`),
    family,
  );
};

const requireActiveGenerationTarget = (
  row: CorpusIndexGenerationContractRow,
  target: { family: CorpusFamily; generation: string },
): void => {
  const expectedCluster = corpusIndexClusterForGeneration(
    target.family,
    target.generation,
  );
  if (row.cluster !== expectedCluster) {
    return panic(
      `Corpus serving target cluster mismatch: ${target.family}/${target.generation}`,
    );
  }
  if (row.cluster === "q09") {
    requireRegisteredCorpusIndexManifest(row);
  }
};

/**
 * Return a retiring generation to the build set before a rollback. Plane must
 * reconcile and prove this generation again before it can become serving.
 */
export const resumeRetiringCorpusIndexGenerationTx = async (
  tx: Transaction,
  target: { family: CorpusFamily; generation: string },
): Promise<void> => {
  await lockCorpusIndexGenerationActivationTx(tx, target.family);
  const rows = await tx
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, target.family),
        eq(corpusIndexGenerations.generation, target.generation),
      ),
    )
    .limit(1)
    .for("update");
  const row = rows.at(0);
  if (row?.status !== "retiring") {
    return panic(
      `Corpus generation is not retiring: ${target.family}/${target.generation}`,
    );
  }
  requireActiveGenerationTarget(row, target);
  await tx
    .update(corpusIndexGenerations)
    .set({ status: "building", updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(corpusIndexGenerations.family, target.family),
        eq(corpusIndexGenerations.generation, target.generation),
        eq(corpusIndexGenerations.status, "retiring"),
      ),
    );
};

/**
 * Register one immutable final-generation contract before any writer targets
 * it. Replays converge; an existing retired or mismatched binding fails closed.
 */
export const registerCorpusIndexGenerationTx = async (
  tx: Transaction,
  target: CorpusIndexGenerationTarget,
): Promise<CorpusIndexManifest> => {
  const manifest = requireCorpusIndexManifest(target.family, target.generation);
  const registered = (
    await tx
      .select()
      .from(corpusIndexGenerations)
      .where(
        and(
          eq(corpusIndexGenerations.family, manifest.family),
          eq(corpusIndexGenerations.generation, manifest.generation),
        ),
      )
      .limit(1)
  ).at(0);
  if (
    registered !== undefined &&
    (registered.status === "building" || registered.status === "serving")
  ) {
    return requireRegisteredCorpusIndexManifest(registered);
  }
  if (registered !== undefined) {
    return panic(
      `Active corpus generation registration failed: ${target.family}/${target.generation}`,
    );
  }
  await lockCorpusIndexGenerationActivationTx(tx, manifest.family);
  await tx
    .insert(corpusIndexGenerations)
    .values({
      family: manifest.family,
      generation: manifest.generation,
      cluster: manifest.cluster,
      manifestDigest: corpusIndexManifestDigest(manifest),
      status: "building",
    })
    .onConflictDoNothing();
  const rows = await tx
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, manifest.family),
        eq(corpusIndexGenerations.generation, manifest.generation),
      ),
    )
    .limit(1)
    .for("share");
  const row = rows.at(0);
  if (
    row === undefined ||
    (row.status !== "building" && row.status !== "serving")
  ) {
    return panic(
      `Active corpus generation registration failed: ${target.family}/${target.generation}`,
    );
  }
  return requireRegisteredCorpusIndexManifest(row);
};

/**
 * Atomically flip one family to a registered generation. Families route and
 * roll back independently; retired generations cannot be resurrected.
 */
export const setServingCorpusIndexGenerationTx = async (
  tx: Transaction,
  target: { family: CorpusFamily; generation: string },
): Promise<ServingCorpusIndexGeneration> => {
  const rows = await tx
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, target.family),
        or(
          eq(corpusIndexGenerations.generation, target.generation),
          eq(corpusIndexGenerations.status, "serving"),
        ),
      ),
    )
    .orderBy(corpusIndexGenerations.generation)
    .limit(2)
    .for("update");
  const targetRow = rows.find((row) => row.generation === target.generation);
  if (
    targetRow === undefined ||
    (targetRow.status !== "building" && targetRow.status !== "serving")
  ) {
    return panic(
      `Corpus serving target is not reconciled: ${target.family}/${target.generation}`,
    );
  }
  requireActiveGenerationTarget(targetRow, target);
  if (targetRow.status === "serving") {
    return requireServingCorpusIndexGeneration(targetRow, target.family);
  }
  await tx
    .update(corpusIndexGenerations)
    .set({ status: "retiring", updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(corpusIndexGenerations.family, target.family),
        eq(corpusIndexGenerations.status, "serving"),
      ),
    );
  const promoted = await tx
    .update(corpusIndexGenerations)
    .set({ status: "serving", updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(corpusIndexGenerations.family, target.family),
        eq(corpusIndexGenerations.generation, target.generation),
      ),
    )
    .returning();
  const promotedRow = promoted.at(0);
  if (promoted.length !== 1 || promotedRow === undefined) {
    return panic(
      `Corpus serving target was lost: ${target.family}/${target.generation}`,
    );
  }
  return requireServingCorpusIndexGeneration(promotedRow, target.family);
};

const CORPUS_INDEX_GENERATION_REBUILD_MAX_BATCH_SIZE = 10_000;

const rebuildRowsOf = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  return isRecord(result) && Array.isArray(result["rows"])
    ? result["rows"]
    : [];
};

const validateRebuildBatchSize = (limit: number): number => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CORPUS_INDEX_GENERATION_REBUILD_MAX_BATCH_SIZE
  ) {
    return panic(
      `Corpus generation rebuild limit must be 1..${CORPUS_INDEX_GENERATION_REBUILD_MAX_BATCH_SIZE}`,
    );
  }
  return limit;
};

const requireRebuildTarget = async (
  tx: Transaction,
  target: CorpusIndexGenerationTarget,
  status: "building" | "retiring",
) => {
  const row = (
    await tx
      .select()
      .from(corpusIndexGenerations)
      .where(
        and(
          eq(corpusIndexGenerations.family, target.family),
          eq(corpusIndexGenerations.generation, target.generation),
        ),
      )
      .limit(1)
      .for("update")
  ).at(0);
  if (row?.status !== status || row.cluster !== "q09") {
    return panic(
      `Corpus generation rebuild requires q09 ${status}: ${target.family}/${target.generation}`,
    );
  }
  return row;
};

/** Remove one non-serving generation from the active projection set. */
export const beginCorpusIndexGenerationRebuildTx = async (
  tx: Transaction,
  target: CorpusIndexGenerationTarget,
): Promise<void> => {
  const row = await requireRebuildTarget(tx, target, "building");
  requireRegisteredCorpusIndexManifest(row);
  const retired = await tx
    .update(corpusIndexGenerations)
    .set({ status: "retiring", updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(corpusIndexGenerations.family, target.family),
        eq(corpusIndexGenerations.generation, target.generation),
        eq(corpusIndexGenerations.status, "building"),
      ),
    )
    .returning({ generation: corpusIndexGenerations.generation });
  if (retired.length !== 1) {
    return panic(
      `Corpus generation rebuild lost its target: ${target.family}/${target.generation}`,
    );
  }
};

type CorpusIndexGenerationRebuildStep =
  | { status: "deleted_history"; stateCount: number; intentCount: number }
  | { status: "empty"; count: 0 };

/** Delete one bounded projection-history page from a retiring generation. */
export const deleteCorpusIndexGenerationProjectionBatchTx = async (
  tx: Transaction,
  target: CorpusIndexGenerationTarget,
  requestedLimit: number,
): Promise<CorpusIndexGenerationRebuildStep> => {
  const limit = validateRebuildBatchSize(requestedLimit);
  await requireRebuildTarget(tx, target, "retiring");
  const purged = await tx.execute(sql`
    SELECT deleted_state_count, deleted_intent_count
      FROM public.purge_rebuilding_corpus_index_projection_history(
        ${target.family}, ${target.generation}, ${limit}
      )
  `);
  const row = rebuildRowsOf(purged).at(0);
  if (
    !isRecord(row) ||
    typeof row["deleted_state_count"] !== "number" ||
    typeof row["deleted_intent_count"] !== "number"
  ) {
    return panic("Corpus generation rebuild purge result is malformed");
  }
  const stateCount = row["deleted_state_count"];
  const intentCount = row["deleted_intent_count"];
  return stateCount > 0 || intentCount > 0
    ? { status: "deleted_history", stateCount, intentCount }
    : { status: "empty", count: 0 };
};

/** Replace one empty, non-serving registration with its current manifest. */
export const completeCorpusIndexGenerationRebuildTx = async (
  tx: Transaction,
  target: CorpusIndexGenerationTarget,
): Promise<void> => {
  await lockCorpusIndexGenerationActivationTx(tx, target.family);
  await requireRebuildTarget(tx, target, "retiring");
  const remaining = await tx.execute(sql`
    SELECT EXISTS (
      SELECT 1
        FROM ${corpusIndexProjectionStates}
       WHERE family = ${target.family}
         AND generation = ${target.generation}
    ) OR EXISTS (
      SELECT 1
        FROM ${corpusIndexProjectionIntents}
       WHERE family = ${target.family}
         AND generation = ${target.generation}
    ) AS present
  `);
  const remainingRow = rebuildRowsOf(remaining).at(0);
  if (!isRecord(remainingRow) || remainingRow["present"] !== false) {
    return panic(
      `Corpus generation rebuild state is not empty: ${target.family}/${target.generation}`,
    );
  }
  const removed = await tx
    .delete(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, target.family),
        eq(corpusIndexGenerations.generation, target.generation),
        eq(corpusIndexGenerations.status, "retiring"),
      ),
    )
    .returning({ generation: corpusIndexGenerations.generation });
  if (removed.length !== 1) {
    return panic(
      `Corpus generation rebuild lost its registration: ${target.family}/${target.generation}`,
    );
  }
  await registerCorpusIndexGenerationTx(tx, target);
};
