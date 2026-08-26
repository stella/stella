import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
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
const MIGRATION_URL = new URL(
  "../../../drizzle/20260826004100_corpus_projection_revision_fence/migration.sql",
  import.meta.url,
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const revision = async (): Promise<number> => {
  const rows = await db
    .select({ value: corpusIndexGenerations.projectionRevision })
    .from(corpusIndexGenerations)
    .where(eq(corpusIndexGenerations.generation, TARGET.generation));
  return rows.at(0)?.value ?? 0;
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    const migration = await Bun.file(MIGRATION_URL).text();
    for (const statement of migration.split("--> statement-breakpoint")) {
      const ddl = statement.trim();
      if (
        !/(?:^|\n)\s*CREATE FUNCTION\b/u.test(ddl) &&
        !/(?:^|\n)\s*REVOKE ALL ON FUNCTION\b/u.test(ddl) &&
        !/(?:^|\n)\s*CREATE TRIGGER\b/u.test(ddl)
      ) {
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- each trigger depends on its preceding production function and privilege statement
      await db.execute(sql.raw(ddl));
    }
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

test("projection mutations advance one durable revision per statement", async () => {
  expect(await revision()).toBe(1);

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
  expect(await revision()).toBe(2);

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
  expect(await revision()).toBe(3);

  await db
    .update(corpusIndexProjectionStates)
    .set({ updatedAt: new Date("2026-08-26T00:00:01.000Z") })
    .where(eq(corpusIndexProjectionStates.family, TARGET.family));
  expect(await revision()).toBe(4);

  await db
    .delete(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, INTENT_ID));
  expect(await revision()).toBe(5);

  await db
    .update(corpusIndexProjectionStates)
    .set({ updatedAt: new Date("2026-08-26T00:00:02.000Z") })
    .where(
      eq(
        corpusIndexProjectionStates.entityId,
        "0198e331-e578-7000-8000-000000000599",
      ),
    );
  expect(await revision()).toBe(5);
});

test("the revision shares the projection mutation transaction", async () => {
  const beforeRollback = await revision();
  // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
  // type-aware lint; capture the rejection explicitly instead.
  const rejection: unknown = await db
    .transaction(async (tx) => {
      await tx
        .update(corpusIndexProjectionStates)
        .set({ updatedAt: new Date("2026-08-26T00:00:03.000Z") })
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
});
