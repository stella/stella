import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionRevisions,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  lockCorpusIndexProjectionIntentMutationsTx,
  lockCorpusIndexProjectionMutationsTx,
  lockCorpusIndexProjectionPromotionTx,
  lockCorpusIndexProjectionRevisionTx,
  readCorpusIndexProjectionRevisionTx,
} from "./corpus-index-projection-revision";

const TARGET = {
  family: "case_law",
  generation: "case_law_v5",
} as const;
const ENTITY_IDS = [
  "0198e331-e578-7000-8000-000000000501",
  "0198e331-e578-7000-8000-000000000502",
] as const;
const INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000503",
);
const MUTATION_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000504",
);
const LEGISLATION_TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const revision = async (): Promise<number> => {
  const rows = await db
    .select({ value: corpusIndexProjectionRevisions.revision })
    .from(corpusIndexProjectionRevisions)
    .where(eq(corpusIndexProjectionRevisions.generation, TARGET.generation))
    .orderBy(sql`${corpusIndexProjectionRevisions.revision} DESC`)
    .limit(1);
  return rows.at(0)?.value ?? 0;
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(corpusIndexGenerations).values({
      ...TARGET,
      cluster: "q09",
      manifestDigest: "a".repeat(64),
      status: "building",
    });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("projection mutations advance one durable revision per transaction", async () => {
  const initialRevision = await revision();
  expect(initialRevision).toBeGreaterThan(0);

  await db.insert(corpusIndexProjectionStates).values([
    {
      ...TARGET,
      entityId: ENTITY_IDS[0],
      desiredAction: "erase",
      desiredEpoch: 1n,
    },
    {
      ...TARGET,
      entityId: ENTITY_IDS[1],
      desiredAction: "erase",
      desiredEpoch: 1n,
    },
  ]);
  const stateRevision = await revision();
  expect(stateRevision).toBeGreaterThan(initialRevision);

  await db.insert(corpusIndexProjectionIntents).values({
    id: INTENT_ID,
    ...TARGET,
    entityId: ENTITY_IDS[0],
    epoch: 1n,
    fingerprint: "b".repeat(64),
    indexId: "case_law_v5_cs_sk",
    status: "cancelled",
    cancelledAt: new Date("2026-08-26T00:00:00.000Z"),
  });
  const intentRevision = await revision();
  expect(intentRevision).toBeGreaterThan(stateRevision);

  await db
    .update(corpusIndexProjectionStates)
    .set({ updatedAt: new Date("2026-08-26T00:00:01.000Z") })
    .where(eq(corpusIndexProjectionStates.family, TARGET.family));
  const updateRevision = await revision();
  expect(updateRevision).toBeGreaterThan(intentRevision);

  await db
    .delete(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, INTENT_ID));
  const deleteRevision = await revision();
  expect(deleteRevision).toBeGreaterThan(updateRevision);

  await db
    .update(corpusIndexProjectionStates)
    .set({ updatedAt: new Date("2026-08-26T00:00:02.000Z") })
    .where(
      eq(
        corpusIndexProjectionStates.entityId,
        "0198e331-e578-7000-8000-000000000599",
      ),
    );
  expect(await revision()).toBe(deleteRevision);
});

test("multiple statements in one transaction share one revision", async () => {
  const before = await revision();
  await db.transaction(async (tx) => {
    await tx
      .update(corpusIndexProjectionStates)
      .set({ updatedAt: new Date("2026-08-26T00:00:03.000Z") })
      .where(eq(corpusIndexProjectionStates.entityId, ENTITY_IDS[0]));
    await tx
      .update(corpusIndexProjectionStates)
      .set({ updatedAt: new Date("2026-08-26T00:00:04.000Z") })
      .where(eq(corpusIndexProjectionStates.entityId, ENTITY_IDS[1]));
  });
  const after = await revision();
  expect(after).toBeGreaterThan(before);
  const rows = await db
    .select({ revision: corpusIndexProjectionRevisions.revision })
    .from(corpusIndexProjectionRevisions)
    .where(eq(corpusIndexProjectionRevisions.generation, TARGET.generation));
  expect(rows.filter(({ revision: value }) => value === after)).toHaveLength(1);
});

test("the revision shares the projection mutation transaction", async () => {
  const beforeRollback = await revision();
  // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
  // type-aware lint; capture the rejection explicitly instead.
  const rejection: unknown = await db
    .transaction(async (tx) => {
      await tx
        .update(corpusIndexProjectionStates)
        .set({ updatedAt: new Date("2026-08-26T00:00:05.000Z") })
        .where(eq(corpusIndexProjectionStates.entityId, ENTITY_IDS[0]));
      throw new Error("roll back revision fixture");
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  expect(rejection).toBeInstanceOf(Error);
  expect(rejection).toMatchObject({ message: "roll back revision fixture" });
  expect(await revision()).toBe(beforeRollback);
});

test("the ingestion role records revisions through the trigger boundary", async () => {
  const before = await revision();
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    await tx
      .update(corpusIndexProjectionStates)
      .set({ updatedAt: new Date("2026-08-26T00:00:06.000Z") })
      .where(eq(corpusIndexProjectionStates.entityId, ENTITY_IDS[0]));
  });
  expect(await revision()).toBeGreaterThan(before);
});

test("the typed read and proof boundaries return the current revision", async () => {
  const [read, locked, promotion] = await db.transaction(async (tx) => {
    const transaction = asTestRaw<Transaction>(tx);
    return [
      await readCorpusIndexProjectionRevisionTx(transaction, TARGET),
      await lockCorpusIndexProjectionRevisionTx(transaction, TARGET),
      await lockCorpusIndexProjectionPromotionTx(transaction, TARGET),
    ];
  });
  expect(read).toBe(await revision());
  expect(locked).toBe(read);
  expect(promotion).toBe(read);
  expect(
    await db
      .select({ revision: corpusIndexProjectionRevisions.revision })
      .from(corpusIndexProjectionRevisions)
      .where(eq(corpusIndexProjectionRevisions.generation, TARGET.generation)),
  ).toHaveLength(1);
});

test("mutation fences validate registered targets in any caller order", async () => {
  await db.insert(corpusIndexGenerations).values({
    ...LEGISLATION_TARGET,
    cluster: "q09",
    manifestDigest: "c".repeat(64),
    status: "building",
  });
  await db.insert(corpusIndexProjectionIntents).values({
    id: MUTATION_INTENT_ID,
    ...TARGET,
    entityId: ENTITY_IDS[1],
    epoch: 1n,
    fingerprint: "d".repeat(64),
    indexId: "case_law_v5_cs_sk",
    status: "cancelled",
    cancelledAt: new Date("2026-08-26T00:00:07.000Z"),
  });

  await db.transaction(async (tx) => {
    const transaction = asTestRaw<Transaction>(tx);
    await lockCorpusIndexProjectionMutationsTx(transaction, [
      LEGISLATION_TARGET,
      TARGET,
      LEGISLATION_TARGET,
    ]);
    await lockCorpusIndexProjectionIntentMutationsTx(transaction, [
      MUTATION_INTENT_ID,
    ]);
  });
});
