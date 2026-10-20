import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { compareCodeUnit } from "@stll/collation";

import {
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { canonicalDecisionIdSql } from "@/api/lib/case-law/decision-alias";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  applyRepublishedDecisionBatch,
  type RepublishedDecisionCandidate,
  reverseRepublishedDecisionBatch,
  selectRepublishedDecisionCandidates,
  selectRepublishedDecisionReport,
} from "@/api/scripts/link-republished-decisions-plan";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const courtSource = createSafeId<"caseLawSource">();
const republisherSource = createSafeId<"caseLawSource">();
const canonicalId = createSafeId<"caseLawDecision">();
const retiredId = createSafeId<"caseLawDecision">();

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    await db.insert(caseLawSources).values([
      { id: courtSource, adapterKey: ADAPTER_KEYS.PL_TK, name: "Court" },
      {
        id: republisherSource,
        adapterKey: ADAPTER_KEYS.PL_COURTS,
        name: "Republisher",
      },
    ]);
    const common = {
      country: "POL",
      court: "Trybunał Konstytucyjny",
      language: "pl",
      caseNumber: "SK 14/11",
      docketFamilyKey: "sk:14:11",
      decisionDate: "2012-07-18",
      decisionType: "wyrok",
    };
    await db.insert(caseLawDecisions).values([
      {
        ...common,
        id: canonicalId,
        sourceId: courtSource,
        sourceDocumentId: "court-1",
        createdAt: new Date("2020-01-01"),
      },
      {
        ...common,
        id: retiredId,
        sourceId: republisherSource,
        sourceDocumentId: "publisher-1",
        createdAt: new Date("2019-01-01"),
      },
    ]);
    await db.insert(caseLawDecisionSourceIdentities).values([
      {
        sourceId: courtSource,
        sourceDocumentId: "court-1",
        decisionId: canonicalId,
        sourceRawS3Key: "raw/court",
      },
      {
        sourceId: republisherSource,
        sourceDocumentId: "publisher-1",
        decisionId: retiredId,
        sourceRawS3Key: "raw/republisher",
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => await client.close());

test("dry run is read-only and court authority wins over storage age", async () => {
  const candidates = await db.transaction(
    async (tx) => await selectRepublishedDecisionCandidates(tx, 10),
  );
  expect(candidates).toHaveLength(1);
  expect(candidates.at(0)).toMatchObject({
    canonical: { id: canonicalId },
    duplicate: { id: retiredId },
  });
  expect(await db.select().from(caseLawDecisionAliases)).toEqual([]);
  expect(await db.select().from(caseLawDecisionSourceIdentities)).toHaveLength(
    2,
  );
});

test("apply resolves the retired id and reverse restores identity ownership", async () => {
  const before = await db.select().from(caseLawDecisionSourceIdentities);
  const candidates = await db.transaction(
    async (tx) => await selectRepublishedDecisionCandidates(tx, 10),
  );
  const reconciled: string[] = [];
  await db.transaction(async (tx) => {
    expect(
      await applyRepublishedDecisionBatch(
        tx,
        candidates,
        async (candidate, direction) => {
          reconciled.push(`${direction}:${candidate.duplicate.id}`);
        },
      ),
    ).toBe(1);
  });
  const identities = await db.select().from(caseLawDecisionSourceIdentities);
  expect(new Set(identities.map(({ decisionId }) => decisionId))).toEqual(
    new Set([canonicalId]),
  );
  const resolved = await db
    .select({ id: canonicalDecisionIdSql(caseLawDecisions.id) })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, retiredId));
  expect(resolved).toEqual([{ id: canonicalId }]);
  expect(reconciled).toEqual([`apply:${retiredId}`]);

  await db.transaction(async (tx) => {
    expect(
      await reverseRepublishedDecisionBatch(
        tx,
        10,
        async (candidate, direction) => {
          reconciled.push(`${direction}:${candidate.duplicate.id}`);
        },
      ),
    ).toBe(1);
  });
  expect(await db.select().from(caseLawDecisionAliases)).toEqual([]);
  expect(
    (await db.select().from(caseLawDecisionSourceIdentities))
      .map(({ sourceId, decisionId, sourceRawS3Key }) => ({
        sourceId,
        decisionId,
        sourceRawS3Key,
      }))
      .toSorted((a, b) => compareCodeUnit(a.sourceId, b.sourceId)),
  ).toEqual(
    before
      .map(({ sourceId, decisionId, sourceRawS3Key }) => ({
        sourceId,
        decisionId,
        sourceRawS3Key,
      }))
      .toSorted((a, b) => compareCodeUnit(a.sourceId, b.sourceId)),
  );
  expect(reconciled).toContain(`reverse:${retiredId}`);
});

test("report counts missing dates and ambiguous matches from the corpus", async () => {
  const ambiguityIds = [
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
  ];
  await db.insert(caseLawDecisions).values([
    ...ambiguityIds.map((id, index) => ({
      id,
      sourceId: index === 0 ? courtSource : republisherSource,
      sourceDocumentId: `ambiguous-${String(index)}`,
      country: "POL",
      court: "Report fixture court",
      language: "pl",
      caseNumber: "R 1/26",
      docketFamilyKey: "r:1:26",
      decisionDate: "2026-01-02",
      decisionType: "ruling",
    })),
    {
      id: createSafeId<"caseLawDecision">(),
      sourceId: courtSource,
      sourceDocumentId: "missing-date",
      country: "POL",
      court: "Partial report fixture court",
      language: "pl",
      caseNumber: "R 2/26",
      docketFamilyKey: "r:2:26",
      decisionType: "ruling",
    },
    {
      id: createSafeId<"caseLawDecision">(),
      sourceId: republisherSource,
      sourceDocumentId: "dated-peer",
      country: "POL",
      court: "Partial report fixture court",
      language: "pl",
      caseNumber: "R 2/26",
      docketFamilyKey: "r:2:26",
      decisionDate: "2026-01-02",
      decisionType: "ruling",
    },
  ]);

  const report = await selectRepublishedDecisionReport(db);

  expect(report.outcomes.separatePartial.dateAbsent).toBe(1);
  expect(report.outcomes.separateAmbiguous).toBe(1);
});

test("reverse restores the projection desired state for every repaired pair", async () => {
  const secondCourtSource = createSafeId<"caseLawSource">();
  const secondCanonicalId = createSafeId<"caseLawDecision">();
  const secondRetiredId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawSources).values({
    id: secondCourtSource,
    adapterKey: ADAPTER_KEYS.PL_KIO,
    name: "Second court",
  });
  const common = {
    country: "POL",
    court: "Krajowa Izba Odwoławcza",
    language: "pl",
    caseNumber: "KIO 42/24",
    docketFamilyKey: "kio:42:24",
    decisionDate: "2024-04-02",
    decisionType: "wyrok",
  };
  await db.insert(caseLawDecisions).values([
    {
      ...common,
      id: secondCanonicalId,
      sourceId: secondCourtSource,
      sourceDocumentId: "second-court",
      createdAt: new Date("2024-04-02"),
    },
    {
      ...common,
      id: secondRetiredId,
      sourceId: republisherSource,
      sourceDocumentId: "second-republisher",
      createdAt: new Date("2024-04-03"),
    },
  ]);
  await db.insert(caseLawDecisionSourceIdentities).values([
    {
      sourceId: secondCourtSource,
      sourceDocumentId: "second-court",
      decisionId: secondCanonicalId,
    },
    {
      sourceId: republisherSource,
      sourceDocumentId: "second-republisher",
      decisionId: secondRetiredId,
    },
  ]);

  const generation = "case_law_v5";
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation,
    cluster: "q09",
    manifestDigest: "0".repeat(64),
    status: "building",
  });
  const desiredValues = (
    candidate: RepublishedDecisionCandidate,
    direction: "apply" | "reverse",
  ) =>
    [candidate.canonical.id, candidate.duplicate.id].map(
      (entityId) =>
        ({
          family: "case_law",
          generation,
          entityId,
          desiredAction:
            entityId === candidate.duplicate.id && direction === "apply"
              ? "erase"
              : "upsert",
          desiredEpoch: 1n,
          desiredFingerprint:
            entityId === candidate.duplicate.id && direction === "apply"
              ? null
              : "a".repeat(64),
          desiredIndexId:
            entityId === candidate.duplicate.id && direction === "apply"
              ? null
              : "b".repeat(64),
        }) satisfies typeof corpusIndexProjectionStates.$inferInsert,
    );
  const conflict = {
    target: [
      corpusIndexProjectionStates.family,
      corpusIndexProjectionStates.generation,
      corpusIndexProjectionStates.entityId,
    ],
    set: {
      desiredAction: sql`excluded.desired_action`,
      desiredFingerprint: sql`excluded.desired_fingerprint`,
      desiredIndexId: sql`excluded.desired_index_id`,
    },
  };
  const candidates = await selectRepublishedDecisionCandidates(db, 10);
  expect(candidates).toHaveLength(2);
  await db.transaction(async (tx) => {
    await applyRepublishedDecisionBatch(
      tx,
      candidates,
      async (candidate, direction) => {
        await tx
          .insert(corpusIndexProjectionStates)
          .values(desiredValues(candidate, direction))
          .onConflictDoUpdate(conflict);
      },
    );
  });
  const desiredActions = async () =>
    Object.fromEntries(
      (
        await db
          .select({
            entityId: corpusIndexProjectionStates.entityId,
            desiredAction: corpusIndexProjectionStates.desiredAction,
          })
          .from(corpusIndexProjectionStates)
      ).map(({ entityId, desiredAction }) => [entityId, desiredAction]),
    );
  expect(await desiredActions()).toMatchObject({
    [retiredId]: "erase",
    [secondRetiredId]: "erase",
  });

  await db.transaction(async (tx) => {
    await reverseRepublishedDecisionBatch(
      tx,
      10,
      async (candidate, direction) => {
        await tx
          .insert(corpusIndexProjectionStates)
          .values(desiredValues(candidate, direction))
          .onConflictDoUpdate(conflict);
      },
    );
  });

  expect(await desiredActions()).toEqual({
    [canonicalId]: "upsert",
    [retiredId]: "upsert",
    [secondCanonicalId]: "upsert",
    [secondRetiredId]: "upsert",
  });
});
