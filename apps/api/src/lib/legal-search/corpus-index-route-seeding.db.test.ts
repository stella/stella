import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexGenerationSeedingPasses,
  corpusIndexProjectionStates,
  corpusIndexRouteSeedings,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  beginCorpusIndexGenerationRebuildTx,
  setServingCorpusIndexGenerationTx,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  lockActiveCorpusProjectionSourceTx,
  synchronizeLockedCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  advanceCorpusIndexGenerationSeedingTx,
  type CorpusIndexSeedingTarget,
  readCorpusIndexRouteSeedingsTx,
} from "@/api/lib/legal-search/corpus-index-route-seeding";
import {
  CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING,
  installCorpusProjectionSeedingGuard,
} from "@/api/tests/helpers/corpus-projection-seeding-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const CASE_LAW_SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000201",
);
const LEGISLATION_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000202",
);
const decisionId = (n: number) =>
  toSafeId<"caseLawDecision">(
    `0198e331-e578-7000-8000-${String(300 + n).padStart(12, "0")}`,
  );
const documentId = (n: number) =>
  toSafeId<"legislationDocument">(
    `0198e331-e578-7000-8000-${String(400 + n).padStart(12, "0")}`,
  );

const CASE_LAW: CorpusIndexSeedingTarget = {
  family: "case_law",
  generation: "case_law_v5",
};
const LEGISLATION: CorpusIndexSeedingTarget = {
  family: "legislation",
  generation: "legislation_v2",
};

/** case_law_v5's routes: the declared jurisdictions' groups in that order. */
const CASE_LAW_V5_ROUTES = [
  "case_law_v5_aut",
  "case_law_v5_bra",
  "case_law_v5_cs_sk",
  "case_law_v5_eu",
  "case_law_v5_gbr",
  "case_law_v5_hun",
  "case_law_v5_pol",
  "case_law_v5_usa",
];

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const inTx = async <T>(work: (tx: Transaction) => Promise<T>): Promise<T> =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

const advance = async (
  target: CorpusIndexSeedingTarget,
  limit: number,
  seedLimit?: number,
) =>
  await inTx(
    async (tx) =>
      await advanceCorpusIndexGenerationSeedingTx(tx, target, {
        limit,
        ...(seedLimit === undefined ? {} : { seedLimit }),
      }),
  );

const readSeedings = async (target: CorpusIndexSeedingTarget) =>
  await inTx(async (tx) => await readCorpusIndexRouteSeedingsTx(tx, target));

const statesOf = async ({ family, generation }: CorpusIndexSeedingTarget) =>
  (
    await db
      .select({ entityId: corpusIndexProjectionStates.entityId })
      .from(corpusIndexProjectionStates)
      .where(
        and(
          eq(corpusIndexProjectionStates.family, family),
          eq(corpusIndexProjectionStates.generation, generation),
        ),
      )
      .orderBy(corpusIndexProjectionStates.entityId)
  ).map(({ entityId }) => entityId);

/**
 * Canonical rows that predate the generation, as data no writer touched
 * since: the rows the walk exists to find.
 */
const standUpUnseeded = async (work: (tx: Transaction) => Promise<void>) =>
  await inTx(async (tx) => {
    await tx.execute(
      sql`SELECT set_config(${CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING}, 'off', true)`,
    );
    await work(tx);
  });

const insertDecisions = async (tx: Transaction, ns: readonly number[]) => {
  await tx.insert(caseLawDecisions).values(
    ns.map((n) => ({
      id: decisionId(n),
      sourceId: CASE_LAW_SOURCE_ID,
      caseNumber: `${n} As 1/2020`,
      court: "Nejvyšší správní soud",
      country: n % 2 === 0 ? "CZE" : "POL",
      language: "cs",
      contentHash: String(n % 10).repeat(64),
    })),
  );
};

/**
 * A decision as the ingestion pipeline leaves it between its insert and the
 * transaction that settles its text: pending, with no text pointers.
 */
const insertPendingDecision = async (tx: Transaction, n: number) => {
  await tx.insert(caseLawDecisions).values({
    id: decisionId(n),
    sourceId: CASE_LAW_SOURCE_ID,
    caseNumber: `${n} As 1/2020`,
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
    corpusMirrorStatus: "pending",
  });
};

/** The settle transaction's projection step, as the pipeline runs it. */
const settleDecision = async (tx: Transaction, n: number) => {
  await tx
    .update(caseLawDecisions)
    .set({ corpusMirrorStatus: "settled" })
    .where(eq(caseLawDecisions.id, decisionId(n)));
  const subject = { family: "case_law", entityId: decisionId(n) } as const;
  const lock = await lockActiveCorpusProjectionSourceTx(tx, subject);
  if (lock === null) {
    throw new Error("expected an active projection");
  }
  await synchronizeLockedCorpusProjectionDesiredStateTx(tx, {
    lock,
    subject,
  });
};

const insertDocuments = async (
  tx: Transaction,
  rows: readonly { n: number; country: string }[],
) => {
  await tx.insert(legislationDocuments).values(
    rows.map(({ n, country }) => ({
      id: documentId(n),
      sourceId: LEGISLATION_SOURCE_ID,
      eli: `eli/${country.toLowerCase()}/sb/2020/${n}`,
      title: `Zákon ${n}`,
      country,
      language: "cs",
      contentHash: String(n % 10).repeat(64),
    })),
  );
};

const register = async (
  generation: "case_law_v5" | "case_law_v6" | "legislation_v2",
  status: "building" | "serving",
) => {
  const manifest = CORPUS_INDEX_MANIFESTS[generation];
  await db.insert(corpusIndexGenerations).values({
    family: manifest.family,
    generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(manifest),
    status,
  });
};

// timeout: builds the PGlite schema from every migration.
beforeAll(async () => {
  client = await createTestPglite();
  await installCorpusProjectionSeedingGuard(client);
  db = drizzle({ client });
}, 120_000);

beforeEach(async () => {
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(legislationDocuments).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(legislationSources).where(sql`true`);
  await db.insert(caseLawSources).values({
    id: CASE_LAW_SOURCE_ID,
    adapterKey: "route-seeding",
    name: "Route seeding",
  });
  await db.insert(legislationSources).values({
    id: LEGISLATION_SOURCE_ID,
    adapterKey: "route-seeding",
    name: "Route seeding",
  });
});

afterAll(async () => {
  await client.close();
});

test("one walk seeds every route of the generation and records exactly what it seeded", async () => {
  await inTx(async (tx) => await insertDecisions(tx, [1, 2, 3, 4, 5]));
  await register("case_law_v5", "building");

  const first = await advance(CASE_LAW, 2);
  expect(first).toMatchObject({ type: "advanced", walked: 2, seeded: 2 });
  if (first.type !== "advanced") {
    return;
  }
  expect(first.pass).toMatchObject({
    number: 1,
    routes: CASE_LAW_V5_ROUTES,
    afterEntityId: decisionId(2),
    walked: 2,
    seeded: 2,
    completedAt: null,
  });
  // The cursor names the last seeded row, and nothing past it is seeded.
  expect(await statesOf(CASE_LAW)).toEqual([decisionId(1), decisionId(2)]);
  const midway = await readSeedings(CASE_LAW);
  expect(midway?.routes.map(({ state }) => state)).toEqual(
    CASE_LAW_V5_ROUTES.map(() => "unseeded"),
  );

  expect(await advance(CASE_LAW, 2)).toMatchObject({
    type: "advanced",
    walked: 2,
    seeded: 2,
  });
  // The last page holds one row.
  expect(await advance(CASE_LAW, 2)).toMatchObject({
    type: "advanced",
    walked: 1,
    seeded: 1,
  });
  const completed = await advance(CASE_LAW, 2);
  expect(completed).toMatchObject({
    type: "completed",
    pass: { number: 1, walked: 5, seeded: 5 },
  });
  expect(await statesOf(CASE_LAW)).toEqual([1, 2, 3, 4, 5].map(decisionId));

  const seeded = await readSeedings(CASE_LAW);
  expect(seeded?.routes.map(({ indexId, state }) => [indexId, state])).toEqual(
    CASE_LAW_V5_ROUTES.map((indexId) => [indexId, "seeded"]),
  );
  expect(
    seeded?.routes.find(({ indexId }) => indexId === "case_law_v5_cs_sk")
      ?.jurisdictions,
  ).toEqual(["CZE", "SVK"]);

  // A completed pass whose routes are all seeded walks nothing again.
  expect(await advance(CASE_LAW, 2)).toMatchObject({
    type: "complete",
    pass: { number: 1 },
  });
});

test("a page that rolls back leaves neither its states nor its cursor", async () => {
  await inTx(async (tx) => await insertDecisions(tx, [1, 2, 3]));
  await register("case_law_v5", "building");

  const rolledBack = await db
    .transaction(async (raw) => {
      const tx = asTestRaw<Transaction>(raw);
      await advanceCorpusIndexGenerationSeedingTx(tx, CASE_LAW, { limit: 2 });
      throw new Error("abort after the page");
    })
    .then(
      () => "committed",
      () => "rolled back",
    );
  expect(rolledBack).toBe("rolled back");
  expect(await statesOf(CASE_LAW)).toEqual([]);
  expect(
    await db.select().from(corpusIndexGenerationSeedingPasses),
  ).toHaveLength(0);

  // The next page starts the pass where nothing was seeded.
  expect(await advance(CASE_LAW, 2)).toMatchObject({
    type: "advanced",
    pass: { number: 1, afterEntityId: decisionId(2), seeded: 2 },
  });
});

test("the seed budget bounds a page's writes and the cursor stops at the last row it accounted for", async () => {
  await inTx(async (tx) => await insertDecisions(tx, [1, 2, 3, 4]));
  await register("case_law_v5", "building");

  expect(await advance(CASE_LAW, 4, 1)).toMatchObject({
    type: "advanced",
    walked: 1,
    seeded: 1,
    pass: { afterEntityId: decisionId(1) },
  });
  expect(await statesOf(CASE_LAW)).toEqual([decisionId(1)]);
});

test("a route that did not exist when the walk began stays unseeded until a pass that saw it completes", async () => {
  await inTx(
    async (tx) =>
      await insertDocuments(tx, [
        { n: 1, country: "CZE" },
        { n: 3, country: "CZE" },
      ]),
  );
  await register("legislation_v2", "building");

  expect(await advance(LEGISLATION, 1)).toMatchObject({
    type: "advanced",
    pass: { number: 1, routes: ["legislation_v2_cze"] },
  });
  // A Slovak document arrives after the pass began, ahead of its cursor.
  await standUpUnseeded(
    async (tx) => await insertDocuments(tx, [{ n: 2, country: "SVK" }]),
  );
  expect(await advance(LEGISLATION, 5)).toMatchObject({ type: "advanced" });
  expect(await advance(LEGISLATION, 5)).toMatchObject({
    type: "completed",
    pass: { number: 1, routes: ["legislation_v2_cze"] },
  });
  // The walk gave the Slovak document a state, but the route was not one it
  // captured, so the fact does not cover it.
  expect(await statesOf(LEGISLATION)).toEqual([1, 2, 3].map(documentId));
  expect(
    (await readSeedings(LEGISLATION))?.routes.map(
      (route) =>
        [
          route.indexId,
          route.state,
          route.state === "unseeded" ? route.reason : route.passNumber,
        ] as const,
    ),
  ).toEqual([
    ["legislation_v2_cze", "seeded", 1],
    ["legislation_v2_svk", "unseeded", "never_walked"],
  ]);

  // The next call sees an unseeded route and walks a second pass.
  expect(await advance(LEGISLATION, 5)).toMatchObject({
    type: "advanced",
    walked: 3,
    seeded: 0,
    pass: {
      number: 2,
      routes: ["legislation_v2_cze", "legislation_v2_svk"],
    },
  });
  expect(await advance(LEGISLATION, 5)).toMatchObject({
    type: "completed",
    pass: { number: 2 },
  });
  expect(
    (await readSeedings(LEGISLATION))?.routes.map(({ state }) => state),
  ).toEqual(["seeded", "seeded"]);
});

test("a jurisdiction routed to a seeded route after its pass began unseeds the route", async () => {
  await register("case_law_v5", "building");
  expect(await advance(CASE_LAW, 10)).toMatchObject({ type: "completed" });
  // As a pass that began before Slovakia joined the shared group left it.
  await db
    .update(corpusIndexRouteSeedings)
    .set({ jurisdictions: ["CZE"] })
    .where(eq(corpusIndexRouteSeedings.indexId, "case_law_v5_cs_sk"));

  const routes = (await readSeedings(CASE_LAW))?.routes ?? [];
  expect(
    routes.find(({ indexId }) => indexId === "case_law_v5_cs_sk"),
  ).toMatchObject({ state: "unseeded", reason: "jurisdiction_added" });
  expect(
    routes
      .filter(({ state }) => state === "seeded")
      .map(({ indexId }) => indexId),
  ).toEqual(CASE_LAW_V5_ROUTES.filter((id) => id !== "case_law_v5_cs_sk"));
  expect(await advance(CASE_LAW, 10)).toMatchObject({
    type: "completed",
    pass: { number: 2 },
  });
});

test("leaving the active set forgets the seeding, and an inactive generation is never walked", async () => {
  await inTx(async (tx) => await insertDecisions(tx, [1, 2]));
  await register("case_law_v5", "serving");
  await register("case_law_v6", "building");
  const v6: CorpusIndexSeedingTarget = {
    family: "case_law",
    generation: "case_law_v6",
  };
  expect(await advance(CASE_LAW, 10)).toMatchObject({ type: "advanced" });
  expect(await advance(CASE_LAW, 10)).toMatchObject({ type: "completed" });
  expect(await advance(v6, 10)).toMatchObject({ type: "advanced" });
  expect(await advance(v6, 10)).toMatchObject({ type: "completed" });

  // v6 serves; v5 retires and stops receiving every change.
  await inTx(async (tx) => await setServingCorpusIndexGenerationTx(tx, v6));
  expect(await readSeedings(CASE_LAW)).toBeNull();
  expect(await advance(CASE_LAW, 10)).toEqual({
    type: "inactive",
    status: "retiring",
  });
  const remaining = await db
    .select({ generation: corpusIndexGenerationSeedingPasses.generation })
    .from(corpusIndexGenerationSeedingPasses);
  expect(remaining).toEqual([{ generation: "case_law_v6" }]);
  expect(
    (
      await db
        .selectDistinct({ generation: corpusIndexRouteSeedings.generation })
        .from(corpusIndexRouteSeedings)
    ).map(({ generation }) => generation),
  ).toEqual(["case_law_v6"]);
});

test("a rebuild takes the generation out of the active set and forgets its seeding", async () => {
  await register("case_law_v5", "building");
  expect(await advance(CASE_LAW, 10)).toMatchObject({ type: "completed" });
  await inTx(
    async (tx) =>
      await beginCorpusIndexGenerationRebuildTx(tx, {
        family: "case_law",
        generation: "case_law_v5",
      }),
  );
  expect(
    await db.select().from(corpusIndexGenerationSeedingPasses),
  ).toHaveLength(0);
  expect(await db.select().from(corpusIndexRouteSeedings)).toHaveLength(0);
});

test("the seeding guard fails a commit that leaves a canonical row unseeded in an active generation", async () => {
  await register("case_law_v5", "building");
  const unseeded = await inTx(
    async (tx) => await insertDecisions(tx, [7]),
  ).then(() => "committed", String);
  expect(unseeded).toContain(
    "no desired state in active generation case_law_v5",
  );
  expect(await db.select().from(caseLawDecisions)).toHaveLength(0);

  // Seeding it in the same transaction satisfies the guard.
  await inTx(async (tx) => {
    await insertDecisions(tx, [7]);
    await advanceCorpusIndexGenerationSeedingTx(tx, CASE_LAW, { limit: 10 });
  });
  expect(await statesOf(CASE_LAW)).toEqual([decisionId(7)]);

  // A projection-epoch write is a claimed change too.
  const bumped = await db
    .transaction(async (raw) => {
      const tx = asTestRaw<Transaction>(raw);
      await tx
        .delete(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, decisionId(7)));
      await tx
        .update(caseLawDecisions)
        .set({ projectionEpoch: 5n })
        .where(eq(caseLawDecisions.id, decisionId(7)));
    })
    .then(() => "committed", String);
  expect(bumped).toContain("no desired state in active generation");
});

test("a decision whose text never settles stays stateless, does not block the walk, and is not counted as seeded", async () => {
  await inTx(async (tx) => {
    await insertDecisions(tx, [1, 3]);
    await insertPendingDecision(tx, 2);
  });
  await register("case_law_v5", "building");

  expect(await advance(CASE_LAW, 10)).toMatchObject({
    type: "advanced",
    walked: 3,
    seeded: 2,
    pass: { walked: 3, seeded: 2, deferred: 1, afterEntityId: decisionId(3) },
  });
  expect(await advance(CASE_LAW, 10)).toMatchObject({
    type: "completed",
    pass: { walked: 3, seeded: 2, deferred: 1 },
  });
  expect(await statesOf(CASE_LAW)).toEqual([decisionId(1), decisionId(3)]);
  expect(
    (await readSeedings(CASE_LAW))?.routes.every(
      ({ state }) => state === "seeded",
    ),
  ).toBe(true);
});

test("a pending decision some generation already holds is seeded, so every generation shows it or none does", async () => {
  await inTx(async (tx) => await insertPendingDecision(tx, 1));
  await register("case_law_v5", "building");
  await register("case_law_v6", "building");
  const v6: CorpusIndexSeedingTarget = {
    family: "case_law",
    generation: "case_law_v6",
  };
  // As a row that was settled, projected and then re-observed: pending again
  // with a state in one generation only.
  await standUpUnseeded(async (tx) => {
    await tx
      .update(caseLawDecisions)
      .set({ corpusMirrorStatus: "settled" })
      .where(eq(caseLawDecisions.id, decisionId(1)));
    await advanceCorpusIndexGenerationSeedingTx(tx, v6, { limit: 10 });
    await tx
      .update(caseLawDecisions)
      .set({ corpusMirrorStatus: "pending" })
      .where(eq(caseLawDecisions.id, decisionId(1)));
  });
  expect(await statesOf(v6)).toEqual([decisionId(1)]);

  expect(await advance(CASE_LAW, 10)).toMatchObject({
    type: "advanced",
    seeded: 1,
    pass: { deferred: 0 },
  });
  expect(await statesOf(CASE_LAW)).toEqual([decisionId(1)]);
});

test("a decision that settles behind the cursor is seeded in every generation by its own settle transaction", async () => {
  await inTx(async (tx) => {
    await insertPendingDecision(tx, 1);
    await insertDecisions(tx, [2, 3]);
  });
  await register("case_law_v5", "building");
  await register("case_law_v6", "building");
  const v6: CorpusIndexSeedingTarget = {
    family: "case_law",
    generation: "case_law_v6",
  };

  expect(await advance(CASE_LAW, 2)).toMatchObject({
    type: "advanced",
    pass: { afterEntityId: decisionId(2), seeded: 1, deferred: 1 },
  });
  // Settling without projecting leaves a settled row with no state: refused.
  const unprojected = await db
    .transaction(async (raw) => {
      await asTestRaw<Transaction>(raw)
        .update(caseLawDecisions)
        .set({ corpusMirrorStatus: "settled" })
        .where(eq(caseLawDecisions.id, decisionId(1)));
    })
    .then(() => "committed", String);
  expect(unprojected).toContain("no desired state in active generation");

  await inTx(async (tx) => await settleDecision(tx, 1));
  expect(await statesOf(CASE_LAW)).toEqual([decisionId(1), decisionId(2)]);
  expect(await statesOf(v6)).toEqual([decisionId(1)]);

  expect(await advance(CASE_LAW, 2)).toMatchObject({ type: "advanced" });
  expect(await advance(CASE_LAW, 2)).toMatchObject({
    type: "completed",
    pass: { walked: 3, seeded: 2, deferred: 1 },
  });
  expect(await statesOf(CASE_LAW)).toEqual([1, 2, 3].map(decisionId));
});
