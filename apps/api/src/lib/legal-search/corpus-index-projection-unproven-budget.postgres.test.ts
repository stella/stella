import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_INDEX_UNPROVEN_APPEND_INTENT_STATUSES } from "@/api/lib/legal-search/corpus-index-projection-contract";
import { CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES } from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  abandonCorpusProjectionAppendTx,
  CORPUS_PROJECTION_UNPROVEN_BYTES_BUDGET_MIN,
  type CorpusProjectionAppendBatchStart,
  type CorpusProjectionIntentLease,
  recordAcceptedCorpusProjectionAppendsTx,
  startCorpusProjectionAppendBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A manifest generation no other gated suite registers. */
const GENERATION = "case_law_v9";
const BUDGET = CORPUS_PROJECTION_UNPROVEN_BYTES_BUDGET_MIN;
const CHAINS = 2;
/** Each chain starts at most this many requests in one run. */
const STARTS_PER_CHAIN = 6;
/**
 * What concurrent chains can hold beyond the budget: each start reads the
 * committed sum, so a start can miss only the other chains' starts still in
 * flight, and every chain has at most one.
 */
const BOUND = BUDGET + CHAINS * CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES;

type Seeded = {
  sourceId: string;
  indexId: string;
  /** Reserved revisions per chain, in the order the chain starts them. */
  leases: CorpusProjectionIntentLease[][];
};

const registerGeneration = async (db: GatedTestDb) => {
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v9,
    ),
    status: "building",
  });
};

/** Reserved revisions on one fresh index, one entity each. */
const seed = async (db: GatedTestDb): Promise<Seeded> => {
  const suffix = Bun.randomUUIDv7().replaceAll("-", "").slice(-12);
  const indexId = `case_law_v9_budget_${suffix}`;
  const sourceId = Bun.randomUUIDv7();
  const fingerprint = "f".repeat(64);
  await db.insert(caseLawSources).values({
    id: toSafeId<"caseLawSource">(sourceId),
    adapterKey: `projection-budget-${suffix}`,
    name: "Projection budget",
  });
  const leases = await Promise.all(
    Array.from({ length: CHAINS }, async (_, chain) => {
      const entities = Array.from(
        { length: STARTS_PER_CHAIN },
        (__, index) => ({
          entityId: Bun.randomUUIDv7(),
          caseNumber: `projection-budget-${suffix}-${chain}-${index}`,
        }),
      );
      await db.insert(caseLawDecisions).values(
        entities.map(({ entityId, caseNumber }) => ({
          id: toSafeId<"caseLawDecision">(entityId),
          sourceId: toSafeId<"caseLawSource">(sourceId),
          caseNumber,
          court: "Test court",
          country: "CZE",
          language: "cs",
          contentHash: "c".repeat(64),
          projectionEpoch: 1n,
        })),
      );
      await db.insert(corpusIndexProjectionStates).values(
        entities.map(({ entityId }) => ({
          family: "case_law" as const,
          generation: GENERATION,
          entityId,
          desiredAction: "upsert" as const,
          desiredEpoch: 1n,
          desiredFingerprint: fingerprint,
          desiredIndexId: indexId,
        })),
      );
      return await db
        .insert(corpusIndexProjectionIntents)
        .values(
          entities.map(({ entityId }) => ({
            id: toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7()),
            family: "case_law" as const,
            generation: GENERATION,
            entityId,
            epoch: 1n,
            fingerprint,
            indexId,
            status: "reserved" as const,
            leaseToken: Bun.randomUUIDv7(),
            leaseExpiresAt: sql`clock_timestamp() + interval '30 minutes'`,
          })),
        )
        .returning()
        .then((rows) =>
          rows.map((row): CorpusProjectionIntentLease => ({
            intentId: row.id,
            family: "case_law",
            generation: GENERATION,
            entityId: row.entityId,
            epoch: row.epoch,
            fingerprint: row.fingerprint,
            indexId: row.indexId,
            leaseToken: row.leaseToken ?? panic("Reserved without a lease"),
            leaseExpiresAt:
              row.leaseExpiresAt ?? panic("Reserved without an expiry"),
            appendMode: "batchable",
          })),
        );
    }),
  );
  return { sourceId, indexId, leases };
};

/** The bytes the index's committed, unproven revisions recorded. */
const unprovenBytesOf = async (db: GatedTestDb, indexId: string) =>
  (
    await db
      .select({
        bytes: sql<number>`coalesce(sum(${corpusIndexProjectionIntents.appendBytes}), 0)::float8`,
      })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          eq(corpusIndexProjectionIntents.generation, GENERATION),
          eq(corpusIndexProjectionIntents.indexId, indexId),
          inArray(corpusIndexProjectionIntents.status, [
            ...CORPUS_INDEX_UNPROVEN_APPEND_INTENT_STATUSES,
          ]),
        ),
      )
  ).at(0)?.bytes ?? panic("The sum returned no row");

const cleanUp = async (db: GatedTestDb, sourceIds: readonly string[]) => {
  const generation = and(
    eq(corpusIndexGenerations.family, "case_law"),
    eq(corpusIndexGenerations.generation, GENERATION),
  );
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1937007986, 1)`);
    await tx
      .update(corpusIndexGenerations)
      .set({ status: "retiring" })
      .where(generation);
    await tx
      .delete(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.generation, GENERATION));
    await tx
      .delete(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.generation, GENERATION));
  });
  await db
    .update(corpusIndexGenerations)
    .set({ status: "retired" })
    .where(generation);
  if (sourceIds.length > 0) {
    await db.delete(caseLawDecisions).where(
      inArray(
        caseLawDecisions.sourceId,
        sourceIds.map((id) => toSafeId<"caseLawSource">(id)),
      ),
    );
    await db.delete(caseLawSources).where(
      inArray(
        caseLawSources.id,
        sourceIds.map((id) => toSafeId<"caseLawSource">(id)),
      ),
    );
  }
  await db.delete(corpusIndexGenerations).where(generation);
};

/**
 * One chain's connection. A start runs in a transaction that stays open
 * after the start returns, until the chain commits it, so a start on the
 * other connection meanwhile reads the sum without it.
 */
type Chain = {
  db: GatedTestDb;
  next: number;
  open: { commit: () => Promise<void> } | null;
  /** Started revisions this chain committed and has not settled. */
  started: CorpusProjectionIntentLease[];
  pendingStart: CorpusProjectionIntentLease | null;
};

const openStart = async (
  chain: Chain,
  lease: CorpusProjectionIntentLease,
  appendBytes: number,
): Promise<CorpusProjectionAppendBatchStart> => {
  const started = Promise.withResolvers<CorpusProjectionAppendBatchStart>();
  const release = Promise.withResolvers<undefined>();
  const transaction = chain.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
    const outcome = await startCorpusProjectionAppendBatchTx(tx, {
      revisions: [{ lease, appendBytes }],
      unprovenBytesBudget: BUDGET,
    });
    started.resolve(outcome);
    await release.promise;
  });
  transaction.catch((error: unknown) => {
    started.reject(error);
  });
  chain.open = {
    commit: async () => {
      release.resolve(undefined);
      await transaction;
    },
  };
  return await started.promise;
};

type Command =
  | { type: "start"; chain: number; bytes: number }
  | { type: "commit"; chain: number }
  | { type: "accept"; chain: number }
  | { type: "settle"; chain: number };

const chainIndex = fc.integer({ min: 0, max: CHAINS - 1 });

const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      type: fc.constant("start" as const),
      chain: chainIndex,
      bytes: fc.oneof(
        fc.integer({ min: 1, max: CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES }),
        fc.constant(CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES),
      ),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant("commit" as const),
      chain: chainIndex,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("accept" as const),
      chain: chainIndex,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("settle" as const),
      chain: chainIndex,
    }),
  },
);

const commitChain = async (chain: Chain) => {
  const { open, pendingStart } = chain;
  if (open === null) {
    return;
  }
  await open.commit();
  chain.open = null;
  if (pendingStart !== null) {
    chain.started.push(pendingStart);
    chain.pendingStart = null;
  }
};

/** Every command but a start, which the property runs itself. */
const applyCommand = async (
  chains: readonly Chain[],
  settler: GatedTestDb,
  next: Exclude<Command, { type: "start" }>,
) => {
  const chain = chains.at(next.chain) ?? panic("No such chain");
  switch (next.type) {
    case "commit":
      await commitChain(chain);
      return;
    case "accept": {
      const lease = chain.started.at(0);
      if (lease === undefined) {
        return;
      }
      await settler.transaction(
        async (tx) =>
          await recordAcceptedCorpusProjectionAppendsTx(tx, {
            accepted: [
              {
                intentId: lease.intentId,
                leaseToken: lease.leaseToken,
                documentCount: 1,
              },
            ],
          }),
      );
      return;
    }
    case "settle": {
      const lease = chain.started.shift();
      if (lease === undefined) {
        return;
      }
      await settler.transaction(
        async (tx) =>
          await abandonCorpusProjectionAppendTx(tx, {
            intentId: lease.intentId,
            leaseToken: lease.leaseToken,
            errorMessage: "settled by the budget property",
          }),
      );
      return;
    }
    default:
      next satisfies never;
      panic(`Unhandled budget command: ${String(next)}`);
  }
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus projection unproven-byte budget (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus projection unproven-byte budget (postgres)", () => {
    test(
      "concurrent chains on two connections hold at most one request each beyond the budget",
      async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db: owner } = openClient();
          const { db: settler } = openClient();
          const chainDbs = Array.from(
            { length: CHAINS },
            () => openClient().db,
          );
          const sourceIds: string[] = [];
          let overshootRuns = 0;
          await registerGeneration(owner);
          try {
            await assertProperty(
              "concurrent chains on two connections hold at most one request each beyond the budget",
              fc.asyncProperty(
                fc.array(command, { minLength: 1, maxLength: 16 }),
                async (commands) => {
                  const seeded = await seed(owner);
                  sourceIds.push(seeded.sourceId);
                  const chains: Chain[] = chainDbs.map((db) => ({
                    db,
                    next: 0,
                    open: null,
                    started: [],
                    pendingStart: null,
                  }));
                  let overshot = false;
                  try {
                    for (const step of commands) {
                      if (step.type === "start") {
                        const chain =
                          chains.at(step.chain) ?? panic("No such chain");
                        await commitChain(chain);
                        const lease = seeded.leases
                          .at(step.chain)
                          ?.at(chain.next);
                        if (lease === undefined) {
                          continue;
                        }
                        chain.next += 1;
                        const before = await unprovenBytesOf(
                          settler,
                          seeded.indexId,
                        );
                        const outcome = await openStart(
                          chain,
                          lease,
                          step.bytes,
                        );
                        // The other chain's open start is not visible here,
                        // so the start decides on what is committed.
                        expect(outcome.status).toBe(
                          before >= BUDGET ? "backpressured" : "admitted",
                        );
                        if (outcome.status === "admitted") {
                          chain.pendingStart = lease;
                        }
                      } else {
                        await applyCommand(chains, settler, step);
                      }
                      const committed = await unprovenBytesOf(
                        settler,
                        seeded.indexId,
                      );
                      overshot ||= committed > BUDGET;
                      expect(committed).toBeLessThanOrEqual(BOUND);
                    }
                  } finally {
                    for (const chain of chains) {
                      await commitChain(chain);
                    }
                  }
                  expect(
                    await unprovenBytesOf(settler, seeded.indexId),
                  ).toBeLessThanOrEqual(BOUND);
                  overshootRuns += overshot ? 1 : 0;
                },
              ),
              { numRuns: 24 },
            );
            // The runs reach the overshoot the bound allows, so the bound is
            // what holds them, not a schedule that never races.
            expect(overshootRuns).toBeGreaterThan(0);
          } finally {
            await cleanUp(owner, sourceIds);
          }
        });
      },
      propertyTestTimeout(300_000),
    );

    test("two chains each starting while the other's start is open both pass, and the next start on either is refused", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: owner } = openClient();
        await registerGeneration(owner);
        const seeded = await seed(owner);
        try {
          const chains: Chain[] = seeded.leases.map(() => ({
            db: openClient().db,
            next: 0,
            open: null,
            started: [],
            pendingStart: null,
          }));
          const first = chains.at(0) ?? panic("Expected two chains");
          const second = chains.at(1) ?? panic("Expected two chains");
          const firstLeases =
            seeded.leases.at(0) ?? panic("Expected two chains");
          const secondLeases =
            seeded.leases.at(1) ?? panic("Expected two chains");
          const lease = (
            leases: readonly CorpusProjectionIntentLease[],
            at: number,
          ) => leases.at(at) ?? panic("Not enough reserved revisions");
          const full = CORPUS_PROJECTION_APPEND_MAX_REQUEST_BYTES;
          expect(
            (await openStart(first, lease(firstLeases, 0), full)).status,
          ).toBe("admitted");
          expect(
            (await openStart(second, lease(secondLeases, 0), full)).status,
          ).toBe("admitted");
          await commitChain(first);
          await commitChain(second);
          expect(await unprovenBytesOf(owner, seeded.indexId)).toBe(2 * full);
          const refused = await openStart(first, lease(firstLeases, 1), 1);
          await commitChain(first);
          expect(refused).toMatchObject({
            status: "backpressured",
            unprovenBytes: 2 * full,
          });
          expect(
            await owner
              .select({ status: corpusIndexProjectionIntents.status })
              .from(corpusIndexProjectionIntents)
              .where(
                eq(
                  corpusIndexProjectionIntents.id,
                  lease(firstLeases, 1).intentId,
                ),
              ),
          ).toEqual([{ status: "reserved" }]);
        } finally {
          await cleanUp(owner, [seeded.sourceId]);
        }
      });
    });
  });
}
