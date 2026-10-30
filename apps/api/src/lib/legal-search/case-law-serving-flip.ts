/**
 * The gated flip of one case-law jurisdiction to a group built beside the
 * serving one.
 *
 * A jurisdiction can be given a new index group without rebuilding anything
 * else: a partial generation (`corpusIndexManifestIsPartial`) holds only that
 * jurisdiction, in its new group, and is built while the serving generation
 * keeps answering from the old group, unchanged. Creating, attesting and
 * filling the new group moves no reader: attestation admits appends into the
 * building target, and reads follow the jurisdiction-serving pointer
 * (`corpus-index-jurisdiction-serving-store.ts`), which only this operation
 * writes.
 *
 * `flipCaseLawJurisdictionServing` is the operation. It writes the pointer
 * only when the building generation passes the gates a generation promotion
 * passes (`corpus-index-promotion-gates.ts`), plus the one that is specific to
 * a partial generation: every decision of the jurisdiction has a desired
 * state in it, so convergence of what was seeded cannot stand for what was
 * never seeded.
 *
 * After the flip the old generation owes the jurisdiction an erasure
 * (`purgeFlippedJurisdictionBatchTx`, bounded, resumable), which the existing
 * erasure path carries out. Nothing here reaches into either generation's
 * indexes.
 */
import { panic, Result, TaggedError } from "better-result";
import { and, asc, eq, gt, notExists, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  corpusIndexGenerations,
  corpusIndexJurisdictionServing,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  parseCorpusIndexClusterForGeneration,
  type QuickwitCluster,
} from "@/api/lib/legal-search/corpus-generation-contract";
import {
  lockCorpusIndexGenerationActivationTx,
  readServingCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import { unattestedCorpusIndexIdsTx } from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  type CorpusIndexManifest,
  corpusIndexManifestCoversJurisdiction,
  corpusIndexManifestDigest,
  corpusIndexManifestIsPartial,
  corpusIndexRoute,
  requireCorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { readCorpusProjectionCensusIndexIdsTx } from "@/api/lib/legal-search/corpus-index-projection-census-store";
import {
  type CorpusIndexProjectionConvergenceStatus,
  readCorpusIndexProjectionConvergenceTx,
} from "@/api/lib/legal-search/corpus-index-projection-convergence";
import { eraseServedElsewhereDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  lockCorpusIndexProjectionPromotionTx,
  lockCorpusIndexProjectionRevisionTx,
  readCorpusIndexProjectionRevisionTx,
} from "@/api/lib/legal-search/corpus-index-projection-revision";
import {
  type CensusEvidence,
  censusIndexes,
  type CensusRefusal,
  checkIndexesHoldDocuments,
  type CorpusGenerationNotConvergedError,
  CorpusGenerationProjectionMovedError,
  type CorpusIndexReader,
  type IndexRefusal,
  requireConverged,
} from "@/api/lib/legal-search/corpus-index-promotion-gates";
import { recordSystemAudit } from "@/api/lib/system-audit/record";

class CaseLawServingFlipUndeclaredError extends TaggedError(
  "CaseLawServingFlipUndeclaredError",
)<{ message: string; generation: string; jurisdiction: string }> {}

class CaseLawServingFlipNoServingGenerationError extends TaggedError(
  "CaseLawServingFlipNoServingGenerationError",
)<{ message: string }> {}

class CaseLawServingFlipNotBuildingError extends TaggedError(
  "CaseLawServingFlipNotBuildingError",
)<{ message: string; generation: string }> {}

class CaseLawServingFlipClusterMismatchError extends TaggedError(
  "CaseLawServingFlipClusterMismatchError",
)<{
  message: string;
  servingCluster: QuickwitCluster;
  buildingCluster: QuickwitCluster;
}> {}

class CaseLawServingFlipNotAttestedError extends TaggedError(
  "CaseLawServingFlipNotAttestedError",
)<{ message: string; indexIds: string[] }> {}

class CaseLawServingFlipIncompleteError extends TaggedError(
  "CaseLawServingFlipIncompleteError",
)<{ message: string; jurisdiction: string }> {}

export type CaseLawServingFlipRefusal =
  | CaseLawServingFlipUndeclaredError
  | CaseLawServingFlipNoServingGenerationError
  | CaseLawServingFlipNotBuildingError
  | CaseLawServingFlipClusterMismatchError
  | CaseLawServingFlipNotAttestedError
  | CaseLawServingFlipIncompleteError
  | CorpusGenerationNotConvergedError
  | IndexRefusal
  | CensusRefusal
  | CorpusGenerationProjectionMovedError;

export type CaseLawServingFlipContext = {
  /** A read-only transaction; it takes no fence and no row lock. */
  readTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  /** A transaction under the maintenance lane, for the proof fence and the flip. */
  writeTransaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  indexClient: (manifest: CorpusIndexManifest) => CorpusIndexReader;
};

export type CaseLawServingFlipOptions = {
  /** The jurisdiction to flip, e.g. `CZE`. */
  jurisdiction: string;
  /** The partial generation that holds it, e.g. `case_law_v9`. */
  generation: string;
  /** `dry_run` proves every gate and writes nothing. */
  mode: "dry_run" | "apply";
};

type CaseLawServingFlipEvidence = {
  revision: number;
  convergence: CorpusIndexProjectionConvergenceStatus;
  documents: { indexId: string; documents: number }[];
  census: CensusEvidence;
};

export type CaseLawServingFlipOutcome =
  | { type: "already_flipped"; generation: string }
  | { type: "proven"; evidence: CaseLawServingFlipEvidence }
  | {
      type: "flipped";
      evidence: CaseLawServingFlipEvidence;
      /** The generation that served the jurisdiction until now. */
      previous: string;
    };

type FlipRegistry =
  | { type: "refused"; refusal: CaseLawServingFlipRefusal }
  | {
      type: "ready";
      /** The generation that serves the jurisdiction today. */
      previous: string;
      flipped: boolean;
    };

/**
 * The registry side of the decision: a serving generation exists, the
 * building generation is registered with the declared manifest on the same
 * cluster, and every group of it under a contract of its own is attested.
 */
const readFlipRegistryTx = async (
  tx: Transaction,
  {
    manifest,
    jurisdiction,
    lock,
  }: {
    manifest: CorpusIndexManifest;
    jurisdiction: string;
    /**
     * `share` in the flipping transaction: a withdrawal of an attestation the
     * flip checked waits until the pointer it was checked for commits.
     */
    lock?: "share";
  },
): Promise<FlipRegistry> => {
  const serving = await readServingCorpusIndexGenerationTx(tx, "case_law");
  if (serving.isErr()) {
    return {
      type: "refused",
      refusal: new CaseLawServingFlipNoServingGenerationError({
        message: "No case-law generation serves; there is nothing to flip from",
      }),
    };
  }
  const row = (
    await tx
      .select({
        status: corpusIndexGenerations.status,
        cluster: corpusIndexGenerations.cluster,
        manifestDigest: corpusIndexGenerations.manifestDigest,
      })
      .from(corpusIndexGenerations)
      .where(
        and(
          eq(corpusIndexGenerations.family, "case_law"),
          eq(corpusIndexGenerations.generation, manifest.generation),
        ),
      )
      .limit(1)
  ).at(0);
  if (
    row?.status !== "building" ||
    row.manifestDigest !== corpusIndexManifestDigest(manifest) ||
    serving.value.generation === manifest.generation
  ) {
    return {
      type: "refused",
      refusal: new CaseLawServingFlipNotBuildingError({
        message: `case_law/${manifest.generation} is not registered as building with the declared manifest`,
        generation: manifest.generation,
      }),
    };
  }
  // Counted rather than compared: a read spans exactly one cluster, however
  // many the contract declares.
  const clusters = new Set<QuickwitCluster>([
    row.cluster,
    serving.value.cluster,
  ]);
  if (clusters.size > 1) {
    return {
      type: "refused",
      refusal: new CaseLawServingFlipClusterMismatchError({
        message: `case_law/${manifest.generation} lives on cluster ${row.cluster}, but the serving generation lives on ${serving.value.cluster}; one read cannot span both`,
        servingCluster: serving.value.cluster,
        buildingCluster: row.cluster,
      }),
    };
  }
  const unattested = await unattestedCorpusIndexIdsTx(
    tx,
    manifest,
    lock === undefined ? {} : { lock },
  );
  if (unattested.length > 0) {
    return {
      type: "refused",
      refusal: new CaseLawServingFlipNotAttestedError({
        message: `The groups of case_law/${manifest.generation} are not attested: ${unattested.join(", ")}`,
        indexIds: unattested,
      }),
    };
  }
  const pointer = (
    await tx
      .select({ generation: corpusIndexJurisdictionServing.generation })
      .from(corpusIndexJurisdictionServing)
      .where(
        and(
          eq(corpusIndexJurisdictionServing.family, "case_law"),
          eq(corpusIndexJurisdictionServing.jurisdiction, jurisdiction),
        ),
      )
      .limit(1)
  ).at(0);
  return {
    type: "ready",
    previous: pointer?.generation ?? serving.value.generation,
    flipped: pointer?.generation === manifest.generation,
  };
};

/**
 * How many decisions of the jurisdiction have no desired state in the
 * generation. A probe by state primary key per decision, stopped at the first
 * found: the flip needs to know whether any exists, not how many.
 */
const hasUnseededDecisionTx = async (
  tx: Transaction,
  { jurisdiction, generation }: { jurisdiction: string; generation: string },
): Promise<boolean> => {
  const [row] = await tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.country, jurisdiction),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(corpusIndexProjectionStates)
            .where(
              and(
                eq(corpusIndexProjectionStates.family, "case_law"),
                eq(corpusIndexProjectionStates.generation, generation),
                eq(corpusIndexProjectionStates.entityId, caseLawDecisions.id),
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/**
 * Flip one jurisdiction to the partial generation that holds it, if and only
 * if that generation is complete and proven. Idempotent: a jurisdiction that
 * already reads from the generation answers `already_flipped`.
 *
 * Plane calls this as its flip step. The gates, in order:
 *
 * 1. the generation is declared, partial, covers the jurisdiction, is
 *    registered as building with the declared manifest on the serving
 *    cluster, and every group of it under its own contract is attested;
 * 2. every decision of the jurisdiction has a desired state in it;
 * 3. its projection has converged (nothing pending, blocked, outstanding or
 *    unpublished, and not empty);
 * 4. its index exists and holds documents;
 * 5. the engine census finds no drift;
 * 6. in the flipping transaction, under the activation and promotion fences,
 *    the projection revision is still the one the proof was taken at.
 *
 * `dry_run` proves 1 to 5 and writes nothing.
 */
export const flipCaseLawJurisdictionServing = async (
  context: CaseLawServingFlipContext,
  options: CaseLawServingFlipOptions,
): Promise<Result<CaseLawServingFlipOutcome, CaseLawServingFlipRefusal>> => {
  const jurisdiction = options.jurisdiction;
  const target = {
    family: "case_law",
    generation: options.generation,
  } as const;
  if (
    parseCorpusIndexClusterForGeneration(target.family, target.generation) ===
    null
  ) {
    return Result.err(
      new CaseLawServingFlipUndeclaredError({
        message: `case_law/${target.generation} is not a generation the code declares`,
        generation: target.generation,
        jurisdiction,
      }),
    );
  }
  const manifest = requireCorpusIndexManifest(target.family, target.generation);
  if (
    !corpusIndexManifestIsPartial(manifest) ||
    !corpusIndexManifestCoversJurisdiction(manifest, jurisdiction)
  ) {
    return Result.err(
      new CaseLawServingFlipUndeclaredError({
        message: `case_law/${target.generation} is not a partial generation that holds ${jurisdiction}`,
        generation: target.generation,
        jurisdiction,
      }),
    );
  }

  const registry = await context.readTransaction(
    async (tx) => await readFlipRegistryTx(tx, { manifest, jurisdiction }),
  );
  if (registry.type === "refused") {
    return Result.err(registry.refusal);
  }
  if (registry.flipped) {
    return Result.ok({
      type: "already_flipped",
      generation: target.generation,
    });
  }

  const unseeded = await context.readTransaction(
    async (tx) =>
      await hasUnseededDecisionTx(tx, {
        jurisdiction,
        generation: target.generation,
      }),
  );
  if (unseeded) {
    return Result.err(
      new CaseLawServingFlipIncompleteError({
        message: `case_law/${target.generation} has not been seeded with every ${jurisdiction} decision`,
        jurisdiction,
      }),
    );
  }

  // The revision is read under the exclusive fence when applying: an unfenced
  // read can miss a writer that drew a lower revision and commits later, and
  // the flip trusts the proof only while this number holds.
  const snapshotTx = async (
    tx: Transaction,
    revision: number,
  ): Promise<{
    revision: number;
    convergence: CorpusIndexProjectionConvergenceStatus;
  }> => ({
    revision,
    convergence: await readCorpusIndexProjectionConvergenceTx(tx, target),
  });
  const snapshot =
    options.mode === "apply"
      ? await context.writeTransaction(
          async (tx) =>
            await snapshotTx(
              tx,
              await lockCorpusIndexProjectionRevisionTx(tx, target),
            ),
        )
      : await context.readTransaction(
          async (tx) =>
            await snapshotTx(
              tx,
              await readCorpusIndexProjectionRevisionTx(tx, target),
            ),
        );
  const converged = requireConverged(target, snapshot.convergence);
  if (converged.isErr()) {
    return Result.err(converged.error);
  }

  const client = context.indexClient(manifest);
  const documents = await checkIndexesHoldDocuments(
    target,
    [corpusIndexRoute(manifest, jurisdiction).indexId],
    client,
  );
  if (documents.isErr()) {
    return Result.err(documents.error);
  }
  const censusIndexIds = await context.readTransaction(
    async (tx) => await readCorpusProjectionCensusIndexIdsTx(tx, target),
  );
  const census = await censusIndexes({
    runInTransaction: context.readTransaction,
    client,
    target,
    indexIds: censusIndexIds,
  });
  if (census.isErr()) {
    return Result.err(census.error);
  }
  const evidence: CaseLawServingFlipEvidence = {
    revision: snapshot.revision,
    convergence: snapshot.convergence,
    documents: documents.value,
    census: census.value,
  };
  if (options.mode === "dry_run") {
    return Result.ok({ type: "proven", evidence });
  }

  return await context.writeTransaction(
    async (
      tx,
    ): Promise<
      Result<CaseLawServingFlipOutcome, CaseLawServingFlipRefusal>
    > => {
      await lockCorpusIndexGenerationActivationTx(tx, target.family);
      const currentRevision = await lockCorpusIndexProjectionPromotionTx(
        tx,
        target,
      );
      if (currentRevision !== snapshot.revision) {
        return Result.err(
          new CorpusGenerationProjectionMovedError({
            message: `${target.family}/${target.generation} changed after the census (projection revision ${String(snapshot.revision)} -> ${String(currentRevision)}); run the flip again`,
            provenRevision: snapshot.revision,
            currentRevision,
          }),
        );
      }
      // The registry may have moved since the proof: decide again under the
      // fences, and apply what this decision says.
      const locked = await readFlipRegistryTx(tx, {
        manifest,
        jurisdiction,
        lock: "share",
      });
      if (locked.type === "refused") {
        return Result.err(locked.refusal);
      }
      if (locked.flipped) {
        return Result.ok({
          type: "already_flipped",
          generation: target.generation,
        });
      }
      await tx
        .insert(corpusIndexJurisdictionServing)
        .values({
          family: target.family,
          jurisdiction,
          generation: target.generation,
          fromGeneration: locked.previous,
        })
        .onConflictDoUpdate({
          target: [
            corpusIndexJurisdictionServing.family,
            corpusIndexJurisdictionServing.jurisdiction,
          ],
          set: {
            generation: target.generation,
            fromGeneration: locked.previous,
            flippedAt: sql`clock_timestamp()`,
          },
        });
      await recordSystemAudit(tx, "system:corpus-generation-operator", {
        subject: createSafeId<"systemScriptRun">(),
        counts: { registered: 0, promoted: 1, demoted: 0 },
      });
      return Result.ok({
        type: "flipped",
        evidence,
        previous: locked.previous,
      });
    },
  );
};

const PURGE_BATCH_MAX = 500;

export type PurgeFlippedJurisdictionBatch = {
  /** Decisions inspected this batch. */
  inspected: number;
  /** Decisions whose old copy is now owed an erasure. */
  scheduled: number;
  /** Where the next batch resumes; null when the jurisdiction is exhausted. */
  nextAfterEntityId: SafeId<"caseLawDecision"> | null;
};

/**
 * Owe the old generation an erasure for every decision of a flipped
 * jurisdiction, one bounded page. The erasure path carries each one out and
 * the old index loses its copies; the generation that now serves the
 * jurisdiction is not touched (`eraseServedElsewhereDesiredStateTx`).
 * Resumable: the cursor is the last decision inspected, and a page over
 * decisions already scheduled changes nothing.
 */
export const purgeFlippedJurisdictionBatchTx = async (
  tx: Transaction,
  {
    jurisdiction,
    fromGeneration,
    afterEntityId,
    limit,
  }: {
    jurisdiction: string;
    /** The generation that served the jurisdiction before the flip. */
    fromGeneration: string;
    afterEntityId: SafeId<"caseLawDecision"> | null;
    limit: number;
  },
): Promise<PurgeFlippedJurisdictionBatch> => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PURGE_BATCH_MAX) {
    return panic(`Purge batch size must be 1..${String(PURGE_BATCH_MAX)}`);
  }
  const pointer = (
    await tx
      .select({
        generation: corpusIndexJurisdictionServing.generation,
        fromGeneration: corpusIndexJurisdictionServing.fromGeneration,
      })
      .from(corpusIndexJurisdictionServing)
      .where(
        and(
          eq(corpusIndexJurisdictionServing.family, "case_law"),
          eq(corpusIndexJurisdictionServing.jurisdiction, jurisdiction),
        ),
      )
      .limit(1)
  ).at(0);
  if (pointer === undefined || pointer.fromGeneration !== fromGeneration) {
    return panic(
      `${jurisdiction} is not flipped away from ${fromGeneration}; nothing may be purged from it`,
    );
  }
  const decisions = await tx
    .select({ id: caseLawDecisions.id })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.country, jurisdiction),
        afterEntityId === null
          ? undefined
          : gt(caseLawDecisions.id, afterEntityId),
      ),
    )
    .orderBy(asc(caseLawDecisions.id))
    .limit(limit);
  let scheduled = 0;
  for (const { id } of decisions) {
    // db-await-in-loop: each decision is locked in the canonical order, one at a time
    const { changed } = await eraseServedElsewhereDesiredStateTx(
      tx,
      { family: "case_law", entityId: id },
      fromGeneration,
    );
    scheduled += changed ? 1 : 0;
  }
  await recordSystemAudit(tx, "system:corpus-generation-operator", {
    subject: createSafeId<"systemScriptRun">(),
    counts: { registered: 0, promoted: 0, demoted: scheduled },
  });
  return {
    inspected: decisions.length,
    scheduled,
    nextAfterEntityId:
      decisions.length < limit ? null : (decisions.at(-1)?.id ?? null),
  };
};
