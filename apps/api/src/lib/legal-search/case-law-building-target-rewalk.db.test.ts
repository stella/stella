/**
 * The scoped rewalk that gives the building target its desired state, against
 * a real PostgreSQL registry: a dry run reports what a page would write, the
 * rewalk creates rows for the target's jurisdictions only and leaves every
 * other generation's and country's rows exactly as they are, and a rerun
 * writes nothing.
 */
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  type BuildingTargetRewalkPage,
  rewalkBuildingTargetBatchTx,
} from "@/api/lib/legal-search/case-law-building-target-rewalk";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { ensureCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const V8 = CORPUS_INDEX_MANIFESTS.case_law_v8;
const V9 = CORPUS_INDEX_MANIFESTS.case_law_v9;

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000601",
);
const CZE_FIRST = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000602",
);
const CZE_SECOND = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000603",
);
const POL_DECISION = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000604",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let seededSnapshot: Blob;

const inTx = async <T>(run: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (tx) => await run(asTestRaw<Transaction>(tx)));

beforeAll(async () => {
  await using template = await createTestPglite();
  const templateDb = drizzle({ client: template });
  await templateDb.insert(corpusIndexGenerations).values([
    {
      family: "case_law",
      generation: V8.generation,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(V8),
      status: "serving",
    },
    {
      family: "case_law",
      generation: V9.generation,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(V9),
      status: "building",
    },
  ]);
  seededSnapshot = await template.dumpDataDir();
});

beforeEach(async () => {
  client = await createTestPglite(seededSnapshot);
  db = drizzle({ client });
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "building-target-rewalk",
    name: "Building target rewalk",
  });
  const decision = (
    id: typeof CZE_FIRST,
    country: string,
    language: string,
    caseNumber: string,
  ) => ({
    id,
    sourceId: SOURCE_ID,
    caseNumber,
    court: "Test court",
    country,
    language,
    contentHash: "a".repeat(64),
  });
  await db
    .insert(caseLawDecisions)
    .values([
      decision(CZE_FIRST, "CZE", "cs", "4 As 3/2008"),
      decision(CZE_SECOND, "CZE", "cs", "4 As 4/2008"),
      decision(POL_DECISION, "POL", "pl", "III SA/Wa 1/2026"),
    ]);
  // The serving generation already holds every decision, as it does in
  // production: the bootstrap of v8 is long complete.
  for (const entityId of [CZE_FIRST, CZE_SECOND, POL_DECISION]) {
    await inTx(
      async (tx) =>
        await ensureCorpusProjectionDesiredStateTx(
          tx,
          { family: "case_law", entityId },
          V8.generation,
        ),
    );
  }
});

afterEach(async () => {
  await client.close();
});

const rowsOf = async (generation: string) =>
  await db
    .select()
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.generation, generation))
    .orderBy(corpusIndexProjectionStates.entityId);

const page = async (
  mode: "dry_run" | "apply",
  afterEntityId: typeof CZE_FIRST | null = null,
  limit = 10,
): Promise<BuildingTargetRewalkPage> =>
  await inTx(
    async (tx) =>
      await rewalkBuildingTargetBatchTx(tx, {
        generation: V9.generation,
        afterEntityId,
        limit,
        mode,
      }),
  );

test("a dry run reports the counts the rewalk would write and writes nothing", async () => {
  const before = await rowsOf(V9.generation);
  expect(before).toEqual([]);
  expect(await page("dry_run")).toEqual({
    mode: "dry_run",
    // The Polish decision is not the target's.
    inspected: 2,
    seeded: 2,
    alreadySeeded: 0,
    nextAfterEntityId: null,
  });
  expect(await rowsOf(V9.generation)).toEqual([]);
});

test("the rewalk creates the target's rows for its jurisdictions only and leaves every other row untouched", async () => {
  const servingBefore = await rowsOf(V8.generation);
  const [canonicalBefore] = await db
    .select({ epoch: caseLawDecisions.projectionEpoch })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, CZE_FIRST));

  const walked = await page("apply");
  expect(walked).toEqual({
    mode: "apply",
    inspected: 2,
    seeded: 2,
    alreadySeeded: 0,
    nextAfterEntityId: null,
  });

  const building = await rowsOf(V9.generation);
  expect(building.map(({ entityId }) => entityId)).toEqual([
    CZE_FIRST,
    CZE_SECOND,
  ]);
  expect(
    building.every(
      ({ desiredAction, desiredIndexId }) =>
        desiredAction === "upsert" && desiredIndexId === "case_law_v9_cze",
    ),
  ).toBe(true);
  // The serving generation's rows, Czech and Polish alike, are byte for byte
  // what they were, fingerprints and epochs included.
  expect(await rowsOf(V8.generation)).toEqual(servingBefore);
  const [canonicalAfter] = await db
    .select({ epoch: caseLawDecisions.projectionEpoch })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, CZE_FIRST));
  expect(canonicalAfter?.epoch).toBe(canonicalBefore?.epoch);
});

test("the walk is resumable page by page and a rerun is a no-op", async () => {
  const first = await page("apply", null, 1);
  expect(first).toMatchObject({
    inspected: 1,
    seeded: 1,
    nextAfterEntityId: CZE_FIRST,
  });
  const second = await page("apply", first.nextAfterEntityId, 1);
  expect(second).toMatchObject({
    inspected: 1,
    seeded: 1,
    nextAfterEntityId: CZE_SECOND,
  });
  const last = await page("apply", second.nextAfterEntityId, 1);
  expect(last).toMatchObject({
    inspected: 0,
    seeded: 0,
    nextAfterEntityId: null,
  });

  const walkedRows = await rowsOf(V9.generation);
  expect(walkedRows).toHaveLength(2);
  // A rerun from the start finds everything seeded and writes nothing.
  expect(await page("apply")).toEqual({
    mode: "apply",
    inspected: 2,
    seeded: 0,
    alreadySeeded: 2,
    nextAfterEntityId: null,
  });
  expect(await page("dry_run")).toMatchObject({ seeded: 0, alreadySeeded: 2 });
  expect(await rowsOf(V9.generation)).toEqual(walkedRows);
});

test("only a partial generation is rewalked", async () => {
  expect(
    String(
      await rejectionOf(
        inTx(
          async (tx) =>
            await rewalkBuildingTargetBatchTx(tx, {
              generation: V8.generation,
              afterEntityId: null,
              limit: 10,
              mode: "dry_run",
            }),
        ),
      ),
    ),
  ).toContain("not a partial generation");
  expect(
    String(
      await rejectionOf(
        inTx(
          async (tx) =>
            await rewalkBuildingTargetBatchTx(tx, {
              generation: V9.generation,
              afterEntityId: null,
              limit: 0,
              mode: "dry_run",
            }),
        ),
      ),
    ),
  ).toContain("Rewalk batch size");
  // The probe above used no write: the registry is as it was.
  expect(await rowsOf(V9.generation)).toEqual([]);
});
