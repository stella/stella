import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { databaseRelations } from "@/api/db/database-relations";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { withCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle<typeof databaseRelations>>;

// timeout: without a CI snapshot, createTestPglite pushes the full schema first.
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: databaseRelations });
}, 120_000);

afterAll(async () => {
  await client.close();
});

/** Every lease query runs as the deployment's ingestion role. */
const ingestionDb: ScopedDb = async (callback) =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
    return await callback(asTestRaw<Transaction>(tx));
  });

const newSource = async () => {
  const sourceId = createSafeId<"caseLawSource">();
  await db
    .insert(caseLawSources)
    .values(
      caseLawSourceRow({ id: sourceId, adapterKey: `lease-owner-${sourceId}` }),
    );
  return sourceId;
};

const leaseOf = async (
  sourceId: ReturnType<typeof createSafeId<"caseLawSource">>,
) =>
  (
    await db
      .select({
        expiresAt: caseLawSources.ingestionLeaseExpiresAt,
        token: caseLawSources.ingestionLeaseToken,
      })
      .from(caseLawSources)
      .where(eq(caseLawSources.id, sourceId))
  ).at(0) ?? panic("lease fixture source is missing");

/** Run work under the owner, counting the releases it makes. */
const runCounted = async <T>(
  sourceId: ReturnType<typeof createSafeId<"caseLawSource">>,
  work: () => Promise<T>,
) => {
  let releases = 0;
  const outcome = await Result.tryPromise({
    try: async () =>
      await withCaseLawSourceIngestionLease(
        {
          scopedDb: ingestionDb,
          sourceId,
          releaseDb: async (query) => {
            releases += 1;
            return await ingestionDb(query);
          },
        },
        async (lease) => {
          // The work runs while this lease is the source's.
          expect((await leaseOf(sourceId)).token).toBe(lease.leaseToken);
          return await work();
        },
      ),
    catch: (cause) => cause,
  });
  return { outcome, releases, lease: await leaseOf(sourceId) };
};

const RELEASED = { expiresAt: null, token: null };

test("the owner releases the lease once for work that completes, fails, or rejects", async () => {
  const sourceId = await newSource();

  const completed = await runCounted(sourceId, async () => "completed");
  expect(completed.outcome.unwrap()).toBe("completed");
  expect(completed.releases).toBe(1);
  expect(completed.lease).toEqual(RELEASED);

  const failure = Result.err(new Error("expected failed result"));
  const failed = await runCounted(sourceId, async () => failure);
  expect(failed.outcome.unwrap()).toBe(failure);
  expect(failed.releases).toBe(1);
  expect(failed.lease).toEqual(RELEASED);

  const rejection = new Error("expected work rejection");
  const rejected = await runCounted(sourceId, async () => {
    throw rejection;
  });
  expect(Result.isError(rejected.outcome) && rejected.outcome.error).toBe(
    rejection,
  );
  expect(rejected.releases).toBe(1);
  expect(rejected.lease).toEqual(RELEASED);
});

test("a source whose lease is held refuses new work without running it, and keeps the holder's lease", async () => {
  const sourceId = await newSource();
  let refusedWorkRan = false;

  const held = await withCaseLawSourceIngestionLease(
    { scopedDb: ingestionDb, sourceId },
    async (lease) => {
      const refused = await withCaseLawSourceIngestionLease(
        { scopedDb: ingestionDb, sourceId },
        async () => {
          refusedWorkRan = true;
        },
      );
      expect(refused).toBeNull();
      expect((await leaseOf(sourceId)).token).toBe(lease.leaseToken);
      return "holder completed";
    },
  );

  expect(held).toBe("holder completed");
  expect(refusedWorkRan).toBe(false);
  expect(await leaseOf(sourceId)).toEqual(RELEASED);
});
