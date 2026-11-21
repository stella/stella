/**
 * A case_law_v7 / case_law_v10 pair ready for the guarded flip, on whatever
 * database `runInTransaction` opens: decisions each generation shows (states
 * and applied revisions written directly), group enrollments attested, route
 * proofs made by the real census pass, seeding by the real walk, and a fake
 * engine that answers the census, the document count and the index
 * incarnation from maps. Shared by the flip's own suite, the operator
 * command's suite and its PostgreSQL suite, so all three flip the same pair.
 */
import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { CorpusIndexFlipEngine } from "@/api/lib/legal-search/corpus-index-generation-flip";
import { registeredCorpusIndexGroups } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  attestCorpusIndexGroupEnrollmentTx,
  bindCorpusIndexGroupEnrollmentTx,
} from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { advanceCorpusIndexRouteProof } from "@/api/lib/legal-search/corpus-index-route-proof";
import { readCorpusIndexRouteProofsTx } from "@/api/lib/legal-search/corpus-index-route-proof-store";
import { advanceCorpusIndexGenerationSeedingTx } from "@/api/lib/legal-search/corpus-index-route-seeding";
import { CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING } from "@/api/tests/helpers/corpus-projection-seeding-guard";

export const FLIP_V7 = "case_law_v7";
export const FLIP_V10 = "case_law_v10";
export type FlipGeneration = typeof FLIP_V7 | typeof FLIP_V10;

const APPLIED_AT = new Date("2026-08-26T00:00:00.000Z");
const fingerprint = (epoch: number) => String(epoch).padStart(64, "0");

/** Time-ordered ids, as decision ids are: a larger n is a newer decision. */
export const flipEntityId = (n: number) =>
  `0198e331-e578-7000-8000-${String(n).padStart(12, "0")}`;
const revisionId = (generation: FlipGeneration, n: number, epoch: number) =>
  toSafeId<"corpusIndexProjectionIntent">(
    `0198e331-e578-7000-9${generation === FLIP_V7 ? "007" : "010"}-${String(n * 10 + epoch).padStart(12, "0")}`,
  );
export const flipRouteOf = (generation: FlipGeneration) => `${generation}_pol`;

/** The source every fixture decision belongs to. */
const FIXTURE_SOURCE = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-00000000f11f",
);

/**
 * The canonical decision behind a fixture state, at least at `epoch` (desired
 * states carry its projection epoch). It stands up data no writer touched,
 * one generation at a time, so its transaction sets the seeding guard's off
 * switch.
 */
const standCanonicalTx = async (tx: Transaction, n: number, epoch: number) => {
  await tx.execute(
    sql`SELECT set_config(${CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING}, 'off', true)`,
  );
  await tx
    .insert(caseLawSources)
    .values({
      id: FIXTURE_SOURCE,
      adapterKey: "flip-fixture",
      name: "Flip fixture",
    })
    .onConflictDoNothing();
  await tx
    .insert(caseLawDecisions)
    .values({
      id: toSafeId<"caseLawDecision">(flipEntityId(n)),
      sourceId: FIXTURE_SOURCE,
      caseNumber: `${String(n)} As 1/2026`,
      court: "Naczelny Sąd Administracyjny",
      country: "POL",
      language: "pl",
      contentHash: String(n).padStart(64, "c"),
      projectionEpoch: BigInt(epoch),
    })
    .onConflictDoUpdate({
      target: caseLawDecisions.id,
      set: {
        projectionEpoch: sql`greatest(${caseLawDecisions.projectionEpoch}, ${BigInt(epoch)})`,
      },
    });
};

const PROJECTION_REVISION_TERM = /projection_revision:"(?<revision>[^"]+)"/gu;

type Runner = <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;

export const createCorpusFlipFixture = (runInTransaction: Runner) => {
  /** What the fake engine holds: projection revision to index and count. */
  const engine = new Map<string, { indexId: string; count: number }>();
  /** Documents lost from an index, by index id. */
  const lost = new Map<string, number>();
  /** The incarnation of each index id; absent means the index is missing. */
  const incarnations = new Map<string, string>();

  const engineClient = {
    aggregate: async ({ query }: { indexId: string; query: string }) =>
      Result.ok({
        projection_revisions: {
          buckets: [...query.matchAll(PROJECTION_REVISION_TERM)].flatMap(
            ({ groups }) => {
              const revision = groups?.["revision"];
              const count =
                revision === undefined
                  ? undefined
                  : engine.get(revision)?.count;
              return count === undefined || count === 0
                ? []
                : [{ key: revision, doc_count: count }];
            },
          ),
          doc_count_error_upper_bound: 0,
          sum_other_doc_count: 0,
        },
      }),
    search: async ({ indexId }: { indexId: string }) =>
      Result.ok({
        numHits:
          [...engine.values()]
            .filter((held) => held.indexId === indexId)
            .reduce((total, held) => total + held.count, 0) -
          (lost.get(indexId) ?? 0),
        hits: [],
        snippets: [],
      }),
    readIndexIncarnation: async (indexId: string) => {
      const incarnation = incarnations.get(indexId);
      return Result.ok(
        incarnation === undefined
          ? ({ type: "missing" } as const)
          : ({ type: "present", incarnation } as const),
      );
    },
  } satisfies CorpusIndexFlipEngine & Record<"aggregate", unknown>;

  const register = async (
    generation: FlipGeneration,
    status: "building" | "serving",
  ) =>
    await runInTransaction(
      async (tx) =>
        await tx.insert(corpusIndexGenerations).values({
          family: "case_law",
          generation,
          cluster: "q09",
          manifestDigest: corpusIndexManifestDigest(
            CORPUS_INDEX_MANIFESTS[generation],
          ),
          status,
        }),
    );

  /** Attest every group the generation enrolls on its own. */
  const attestGroups = async (generation: FlipGeneration) => {
    const manifest = CORPUS_INDEX_MANIFESTS[generation];
    for (const group of registeredCorpusIndexGroups(manifest)) {
      // db-await-in-loop: one attestation per registered group
      await runInTransaction(async (tx) => {
        await bindCorpusIndexGroupEnrollmentTx(tx, {
          manifest,
          indexGroup: group.indexGroup,
        });
        await attestCorpusIndexGroupEnrollmentTx(tx, {
          manifest,
          indexGroup: group.indexGroup,
          effectiveDigest: group.effectiveDigest,
        });
      });
    }
  };

  /** Prove every route the generation declares through the real census pass. */
  const proveRoutes = async (generation: FlipGeneration) => {
    const read = await runInTransaction(
      async (tx) =>
        await readCorpusIndexRouteProofsTx(tx, {
          family: "case_law",
          generation,
        }),
    );
    if (read.type !== "not_ready" && read.type !== "all_current") {
      panic(`Unexpected route proofs: ${read.type}`);
    }
    for (const { indexId } of read.routes) {
      if (!incarnations.has(indexId)) {
        incarnations.set(indexId, `${indexId}:01JFIRST`);
      }
      for (let page = 0; ; page += 1) {
        // db-await-in-loop: each page's cursor is the one the page before recorded
        const step = await advanceCorpusIndexRouteProof({
          runInTransaction,
          client: engineClient,
          admit: async (_unit, work) => await work(),
          route: { family: "case_law", generation, indexId },
          limit: 8,
        });
        if (step.isErr() || page > 50) {
          panic(`Route census failed on ${indexId}`);
        }
        if (step.value.type === "proven") {
          break;
        }
      }
    }
  };

  /** Walk the generation's seeding pass to its end. */
  const seedRoutes = async (generation: FlipGeneration) => {
    for (let page = 0; page < 20; page += 1) {
      // db-await-in-loop: each page resumes from the cursor the page before stored
      const step = await runInTransaction(
        async (tx) =>
          await advanceCorpusIndexGenerationSeedingTx(
            tx,
            { family: "case_law", generation },
            { limit: 100 },
          ),
      );
      if (step.type === "completed" || step.type === "complete") {
        return;
      }
    }
    panic(`Seeding did not end: ${generation}`);
  };

  /**
   * A decision the generation shows at `epoch`, held by the engine: the
   * desired state, then its revision through the append lifecycle the
   * database's triggers allow (reserved, started, committed, applied), then
   * the state naming it as applied.
   */
  const seedShown = async (
    generation: FlipGeneration,
    n: number,
    epoch = 1,
  ) => {
    const revision = revisionId(generation, n, epoch);
    const indexId = flipRouteOf(generation);
    const desired = {
      desiredAction: "upsert" as const,
      desiredEpoch: BigInt(epoch),
      desiredFingerprint: fingerprint(epoch),
      desiredIndexId: indexId,
    };
    const ofRevision = eq(corpusIndexProjectionIntents.id, revision);
    const ofState = and(
      eq(corpusIndexProjectionStates.generation, generation),
      eq(corpusIndexProjectionStates.entityId, flipEntityId(n)),
    );
    await runInTransaction(async (tx) => {
      await standCanonicalTx(tx, n, epoch);
      await tx
        .insert(corpusIndexProjectionStates)
        .values({
          family: "case_law",
          generation,
          entityId: flipEntityId(n),
          ...desired,
        })
        .onConflictDoUpdate({
          target: [
            corpusIndexProjectionStates.family,
            corpusIndexProjectionStates.generation,
            corpusIndexProjectionStates.entityId,
          ],
          set: desired,
        });
      await tx.insert(corpusIndexProjectionIntents).values({
        id: revision,
        family: "case_law",
        generation,
        entityId: flipEntityId(n),
        epoch: BigInt(epoch),
        fingerprint: fingerprint(epoch),
        indexId,
        status: "reserved",
        leaseToken: Bun.randomUUIDv7(),
        leaseExpiresAt: sql`clock_timestamp() + interval '5 minutes'`,
      });
      await tx
        .update(corpusIndexProjectionIntents)
        .set({ status: "append_started", appendStartedAt: APPLIED_AT })
        .where(ofRevision);
      await tx
        .update(corpusIndexProjectionIntents)
        .set({
          status: "append_committed",
          appendCommittedAt: APPLIED_AT,
          expectedDocumentCount: 3,
        })
        .where(ofRevision);
      await tx
        .update(corpusIndexProjectionIntents)
        .set({
          status: "applied",
          leaseToken: null,
          leaseExpiresAt: null,
          appliedAt: APPLIED_AT,
        })
        .where(ofRevision);
      await tx
        .update(corpusIndexProjectionStates)
        .set({
          appliedAction: "upsert",
          appliedEpoch: BigInt(epoch),
          appliedRevision: revision,
          appliedFingerprint: fingerprint(epoch),
          appliedIndexId: indexId,
          appliedAt: APPLIED_AT,
        })
        .where(ofState);
    });
    engine.set(revision, { indexId, count: 3 });
  };

  /** A decision the generation wants erased and never showed. */
  const seedErased = async (generation: FlipGeneration, n: number) =>
    await runInTransaction(
      async (tx) =>
        await tx.insert(corpusIndexProjectionStates).values({
          family: "case_law",
          generation,
          entityId: flipEntityId(n),
          desiredAction: "erase",
          desiredEpoch: 1n,
          appliedAction: "erase",
          appliedEpoch: 1n,
          appliedAt: APPLIED_AT,
        }),
    );

  /** The generation was handed a change it has not applied yet. */
  const seedPending = async (
    generation: FlipGeneration,
    n: number,
    epoch: number,
  ) =>
    await runInTransaction(
      async (tx) =>
        await tx
          .update(corpusIndexProjectionStates)
          .set({
            desiredEpoch: BigInt(epoch),
            desiredFingerprint: fingerprint(epoch),
          })
          .where(
            and(
              eq(corpusIndexProjectionStates.generation, generation),
              eq(corpusIndexProjectionStates.entityId, flipEntityId(n)),
            ),
          ),
    );

  /** v7 serves, v10 builds; both show decisions 1-3, every route proven and seeded. */
  const readyPair = async () => {
    await register(FLIP_V7, "serving");
    await register(FLIP_V10, "building");
    for (const generation of [FLIP_V7, FLIP_V10] as const) {
      for (const n of [1, 2, 3]) {
        // db-await-in-loop: fixture rows, in order
        await seedShown(generation, n);
      }
      // db-await-in-loop: fixture steps, in order
      await attestGroups(generation);
      // db-await-in-loop: fixture steps, in order
      await proveRoutes(generation);
      // db-await-in-loop: fixture steps, in order
      await seedRoutes(generation);
    }
  };

  /** Remove the fixture's canonical decisions, for a suite that keeps its rows. */
  const removeCanonical = async () =>
    await runInTransaction(async (tx) => {
      await tx
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, FIXTURE_SOURCE));
      await tx
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, FIXTURE_SOURCE));
    });

  /** The engine loses a decision's documents, as a lost split would. */
  const loseRevision = (generation: FlipGeneration, n: number, epoch = 1) => {
    engine.delete(revisionId(generation, n, epoch));
  };

  const reset = () => {
    engine.clear();
    lost.clear();
    incarnations.clear();
  };

  return {
    engineClient,
    lost,
    incarnations,
    reset,
    removeCanonical,
    register,
    attestGroups,
    proveRoutes,
    seedRoutes,
    seedShown,
    seedErased,
    seedPending,
    readyPair,
    loseRevision,
  };
};
