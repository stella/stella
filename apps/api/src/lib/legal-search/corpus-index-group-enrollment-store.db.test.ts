import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexGroupEnrollments,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { resolveCorpusIndexGroupContract } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  attestCorpusIndexGroupEnrollmentTx,
  bindCorpusIndexGroupEnrollmentTx,
  readCorpusIndexGroupReadinessTx,
  readServingCorpusIndexTargetTx,
  unattestedCorpusIndexIdsTx,
} from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { advanceCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { reserveCorpusProjectionIntentsTx } from "@/api/lib/legal-search/corpus-index-projection-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v7;
const USA = { manifest: MANIFEST, indexGroup: "usa" } as const;
const USA_CONTRACT = resolveCorpusIndexGroupContract(USA);
const USA_DIGEST =
  USA_CONTRACT.type === "court_partition_v1"
    ? USA_CONTRACT.effectiveDigest
    : "usa is not under its own contract";
const ATTEST_USA = { ...USA, effectiveDigest: USA_DIGEST } as const;
const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000301",
);
const USA_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000302",
);
const CZE_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000303",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const inTx = async <T>(run: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (tx) => await run(asTestRaw<Transaction>(tx)));

const readiness = async () =>
  await inTx(
    async (tx) => await readCorpusIndexGroupReadinessTx(tx, USA_CONTRACT),
  );

beforeEach(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: MANIFEST.generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "serving",
  });
});

afterEach(async () => {
  await client.close();
});

test("binding converges, attestation is separate, and neither overwrites a bound contract", async () => {
  expect(await readiness()).toEqual({ type: "unready", reason: "unbound" });

  const first = await inTx(
    async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA),
  );
  const replay = await inTx(
    async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA),
  );
  expect(replay).toEqual(first);
  expect(first).toMatchObject({
    physicalIndexId: "case_law_v7_usa",
    contractVersion: "court_partition_v1",
    effectiveDigest: USA_DIGEST,
    provisioningStatus: "pending",
    attestedAt: null,
  });
  expect(await readiness()).toEqual({ type: "unready", reason: "pending" });

  // Only the declared contract can be attested.
  await expect(
    inTx(
      async (tx) =>
        await attestCorpusIndexGroupEnrollmentTx(tx, {
          ...USA,
          effectiveDigest: "0".repeat(64),
        }),
    ),
  ).rejects.toThrow("not the declared one");
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  // A replayed attestation converges.
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  expect(await readiness()).toEqual({ type: "attested" });

  // A row bound to another digest is never rebound or read as ready.
  await db
    .update(corpusIndexGroupEnrollments)
    .set({ effectiveDigest: "f".repeat(64) })
    .where(eq(corpusIndexGroupEnrollments.indexGroup, "usa"));
  expect(await readiness()).toEqual({
    type: "unready",
    reason: "contract_mismatch",
  });
  await expect(
    inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA)),
  ).rejects.toThrow("bound to another contract");
});

test("a group under its manifest's contract is never enrolled and never waits", async () => {
  const cze = { manifest: MANIFEST, indexGroup: "cs_sk" } as const;
  await expect(
    inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, cze)),
  ).rejects.toThrow("under its manifest's contract");
  expect(
    await inTx(
      async (tx) =>
        await readCorpusIndexGroupReadinessTx(
          tx,
          resolveCorpusIndexGroupContract(cze),
        ),
    ),
  ).toEqual({ type: "base" });
  expect(
    await inTx(
      async (tx) =>
        await unattestedCorpusIndexIdsTx(
          tx,
          CORPUS_INDEX_MANIFESTS.legislation_v2,
        ),
    ),
  ).toEqual([]);
});

test("a scoped read of a group refuses until it is attested; other reads never wait on it", async () => {
  const target = async (jurisdiction: string | undefined) =>
    await inTx(
      async (tx) =>
        await readServingCorpusIndexTargetTx(tx, {
          family: "case_law",
          jurisdiction,
        }),
    );
  const refusal = await target("USA").then(
    () => null,
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(HandlerError);
  expect(refusal).toMatchObject({ status: 503 });
  expect((await target("CZE")).contract?.type).toBe("base");
  expect((await target(undefined)).contract).toBeNull();

  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA));
  await expect(target("USA")).rejects.toBeInstanceOf(HandlerError);
  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  expect((await target("USA")).contract).toBe(USA_CONTRACT);
});

test("no append reaches a group before its attestation, and its work waits rather than fails", async () => {
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "group-enrollment",
    name: "Group enrollment",
  });
  await db.insert(caseLawDecisions).values([
    {
      id: USA_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "No. 19-1392",
      court: "Supreme Court of the United States",
      courtId: "scotus",
      country: "USA",
      language: "en",
      contentHash: "a".repeat(64),
    },
    {
      id: CZE_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "4 As 3/2008",
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
      contentHash: "b".repeat(64),
    },
  ]);
  for (const entityId of [USA_DECISION_ID, CZE_DECISION_ID]) {
    await inTx(
      async (tx) =>
        await advanceCorpusProjectionDesiredStateTx(tx, {
          family: "case_law",
          entityId,
        }),
    );
  }
  expect(
    await db
      .select({
        entityId: corpusIndexProjectionStates.entityId,
        indexId: corpusIndexProjectionStates.desiredIndexId,
      })
      .from(corpusIndexProjectionStates)
      .orderBy(corpusIndexProjectionStates.entityId),
  ).toEqual([
    { entityId: USA_DECISION_ID, indexId: "case_law_v7_usa" },
    { entityId: CZE_DECISION_ID, indexId: "case_law_v7_cs_sk" },
  ]);

  const reserve = async () =>
    (
      await inTx(
        async (tx) =>
          await reserveCorpusProjectionIntentsTx(tx, {
            family: "case_law",
            generation: MANIFEST.generation,
            limit: 10,
            leaseMs: 60_000,
          }),
      )
    ).map(({ entityId }) => entityId);
  const reserveRoute = async (indexId: string) =>
    await inTx(
      async (tx) =>
        await reserveCorpusProjectionIntentsTx(tx, {
          family: "case_law",
          generation: MANIFEST.generation,
          scope: { type: "route", indexId },
          limit: 10,
          leaseMs: 60_000,
        }),
    );

  expect(await reserve()).toEqual([CZE_DECISION_ID]);
  expect(await reserveRoute("case_law_v7_usa")).toEqual([]);
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA));
  expect(await reserve()).toEqual([]);
  expect(
    await db
      .select({ status: corpusIndexProjectionStates.workStatus })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, USA_DECISION_ID)),
  ).toEqual([{ status: "eligible" }]);

  await inTx(
    async (tx) => await attestCorpusIndexGroupEnrollmentTx(tx, ATTEST_USA),
  );
  expect(await reserve()).toEqual([USA_DECISION_ID]);
  expect(
    await db
      .select({ indexId: corpusIndexProjectionIntents.indexId })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.entityId, USA_DECISION_ID)),
  ).toEqual([{ indexId: "case_law_v7_usa" }]);
});

test("a generation's enrollments leave with its registration", async () => {
  await inTx(async (tx) => await bindCorpusIndexGroupEnrollmentTx(tx, USA));
  await db.delete(corpusIndexGenerations).where(sql`true`);
  expect(await db.select().from(corpusIndexGroupEnrollments)).toEqual([]);
});
