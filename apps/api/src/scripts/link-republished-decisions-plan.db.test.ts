import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
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
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
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
        rawOwnerDecisionId: canonicalId,
        sourceRawS3Key: "raw/court",
      },
      {
        sourceId: republisherSource,
        sourceDocumentId: "publisher-1",
        decisionId: retiredId,
        rawOwnerDecisionId: retiredId,
        sourceRawS3Key: "raw/republisher",
      },
      {
        sourceId: republisherSource,
        sourceDocumentId: "publisher-already-canonical",
        decisionId: canonicalId,
        rawOwnerDecisionId: canonicalId,
        sourceRawS3Key: "raw/already-canonical",
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
    3,
  );
});

test("apply skips a candidate whose canonical decision was erased after selection", async () => {
  const selectedCanonicalId = createSafeId<"caseLawDecision">();
  const selectedRetiredId = createSafeId<"caseLawDecision">();
  const common = {
    country: "POL",
    court: "Erasure fixture court",
    language: "pl",
    caseNumber: "E 1/26",
    docketFamilyKey: "e:1:26",
    decisionDate: "2026-03-04",
    decisionType: "wyrok",
  };
  await db.insert(caseLawDecisions).values([
    {
      ...common,
      id: selectedCanonicalId,
      sourceId: courtSource,
      sourceDocumentId: "erasure-court",
      createdAt: new Date("2026-03-04"),
    },
    {
      ...common,
      id: selectedRetiredId,
      sourceId: republisherSource,
      sourceDocumentId: "erasure-republisher",
      createdAt: new Date("2026-03-05"),
    },
  ]);
  await db.insert(caseLawDecisionSourceIdentities).values([
    {
      sourceId: courtSource,
      sourceDocumentId: "erasure-court",
      decisionId: selectedCanonicalId,
      rawOwnerDecisionId: selectedCanonicalId,
    },
    {
      sourceId: republisherSource,
      sourceDocumentId: "erasure-republisher",
      decisionId: selectedRetiredId,
      rawOwnerDecisionId: selectedRetiredId,
    },
  ]);
  const candidates = await selectRepublishedDecisionCandidates(db, 100);
  const candidate = candidates.find(
    ({ duplicate }) => duplicate.id === selectedRetiredId,
  );
  expect(candidate).toBeDefined();

  await db
    .update(caseLawDecisions)
    .set({ redactedAt: new Date("2026-03-06") })
    .where(eq(caseLawDecisions.id, selectedCanonicalId));
  expect(
    (await selectRepublishedDecisionCandidates(db, 100)).some(
      ({ canonical, duplicate }) =>
        canonical.id === selectedCanonicalId ||
        duplicate.id === selectedCanonicalId,
    ),
  ).toBe(false);

  if (!candidate) {
    return panic("Erasure fixture must be selected before redaction");
  }
  await db.transaction(async (tx) => {
    expect(
      await applyRepublishedDecisionBatch(tx, [candidate], async () =>
        panic("An erased candidate must not be reconciled"),
      ),
    ).toEqual([{ type: "skipped_erased", retiredId: selectedRetiredId }]);
  });
  expect(
    await db
      .select()
      .from(caseLawDecisionAliases)
      .where(eq(caseLawDecisionAliases.retiredDecisionId, selectedRetiredId)),
  ).toEqual([]);
  expect(
    await db
      .select({ decisionId: caseLawDecisionSourceIdentities.decisionId })
      .from(caseLawDecisionSourceIdentities)
      .where(
        inArray(caseLawDecisionSourceIdentities.decisionId, [
          selectedCanonicalId,
          selectedRetiredId,
        ]),
      ),
  ).toEqual(
    expect.arrayContaining([
      { decisionId: selectedCanonicalId },
      { decisionId: selectedRetiredId },
    ]),
  );
  await db
    .delete(caseLawDecisionSourceIdentities)
    .where(
      inArray(caseLawDecisionSourceIdentities.decisionId, [
        selectedCanonicalId,
        selectedRetiredId,
      ]),
    );
  await db
    .delete(caseLawDecisions)
    .where(
      inArray(caseLawDecisions.id, [selectedCanonicalId, selectedRetiredId]),
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
        async (applied, direction) => {
          reconciled.push(
            ...applied.map(
              (candidate) => `${direction}:${candidate.duplicate.id}`,
            ),
          );
        },
      ),
    ).toEqual([{ type: "linked", retiredId }]);
  });
  const identities = await db.select().from(caseLawDecisionSourceIdentities);
  expect(new Set(identities.map(({ decisionId }) => decisionId))).toEqual(
    new Set([canonicalId]),
  );
  expect(
    identities
      .map(({ sourceDocumentId, rawOwnerDecisionId }) => ({
        sourceDocumentId,
        rawOwnerDecisionId,
      }))
      .toSorted((a, b) =>
        compareCodeUnit(a.sourceDocumentId, b.sourceDocumentId),
      ),
  ).toEqual([
    {
      sourceDocumentId: "court-1",
      rawOwnerDecisionId: canonicalId,
    },
    {
      sourceDocumentId: "publisher-1",
      rawOwnerDecisionId: retiredId,
    },
    {
      sourceDocumentId: "publisher-already-canonical",
      rawOwnerDecisionId: canonicalId,
    },
  ]);
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
        async (reversed, direction) => {
          reconciled.push(
            ...reversed.map(
              (candidate) => `${direction}:${candidate.duplicate.id}`,
            ),
          );
        },
      ),
    ).toEqual([{ type: "reversed", retiredId }]);
  });
  expect(await db.select().from(caseLawDecisionAliases)).toEqual([]);
  expect(
    (await db.select().from(caseLawDecisionSourceIdentities))
      .map(({ sourceId, decisionId, sourceRawS3Key }) => ({
        sourceId,
        decisionId,
        sourceRawS3Key,
      }))
      .toSorted((a, b) =>
        compareCodeUnit(
          `${a.sourceId}:${a.sourceRawS3Key ?? ""}`,
          `${b.sourceId}:${b.sourceRawS3Key ?? ""}`,
        ),
      ),
  ).toEqual(
    before
      .map(({ sourceId, decisionId, sourceRawS3Key }) => ({
        sourceId,
        decisionId,
        sourceRawS3Key,
      }))
      .toSorted((a, b) =>
        compareCodeUnit(
          `${a.sourceId}:${a.sourceRawS3Key ?? ""}`,
          `${b.sourceId}:${b.sourceRawS3Key ?? ""}`,
        ),
      ),
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

test("court-name fallback links whichever UUID side has the court id", async () => {
  await db.execute(
    sql`ALTER TABLE case_law_decisions DROP CONSTRAINT case_law_decisions_court_id_by_country`,
  );
  const orientations = ["lower", "higher"] as const;
  const expected = new Set<SafeId<"caseLawDecision">>();
  for (const [index, courtIdSide] of orientations.entries()) {
    const ids = [
      createSafeId<"caseLawDecision">(),
      createSafeId<"caseLawDecision">(),
    ].toSorted(compareCodeUnit);
    const lowerId =
      ids.at(0) ?? panic("Court orientation fixture requires two decision ids");
    const higherId =
      ids.at(1) ?? panic("Court orientation fixture requires two decision ids");
    expected.add(lowerId);
    expected.add(higherId);
    await db.insert(caseLawDecisions).values([
      {
        id: lowerId,
        sourceId: courtSource,
        sourceDocumentId: `court-orientation-${String(index)}`,
        country: "POL",
        court: "Sąd orientacyjny",
        courtId: courtIdSide === "lower" ? `pl:orientation:${index}` : null,
        language: "pl",
        caseNumber: `O ${String(index + 1)}/26`,
        docketFamilyKey: `o:${String(index + 1)}:26`,
        decisionDate: "2026-02-03",
        decisionType: "wyrok",
      },
      {
        id: higherId,
        sourceId: republisherSource,
        sourceDocumentId: `republisher-orientation-${String(index)}`,
        country: "POL",
        court: "Sąd orientacyjny",
        courtId: courtIdSide === "higher" ? `pl:orientation:${index}` : null,
        language: "pl",
        caseNumber: `O ${String(index + 1)}/26`,
        docketFamilyKey: `o:${String(index + 1)}:26`,
        decisionDate: "2026-02-03",
        decisionType: "wyrok",
      },
    ]);
  }

  const candidates = await selectRepublishedDecisionCandidates(db, 100);
  const linkedIds = new Set(
    candidates.flatMap(({ canonical, duplicate }) => [
      canonical.id,
      duplicate.id,
    ]),
  );
  for (const id of expected) {
    expect(linkedIds.has(id)).toBe(true);
  }
  await db
    .delete(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, [...expected]));
  await db.execute(sql`
    ALTER TABLE case_law_decisions
      ADD CONSTRAINT case_law_decisions_court_id_by_country
      CHECK ((country IN ('USA')) = (court_id IS NOT NULL)) NOT VALID
  `);
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
      rawOwnerDecisionId: secondCanonicalId,
    },
    {
      sourceId: republisherSource,
      sourceDocumentId: "second-republisher",
      decisionId: secondRetiredId,
      rawOwnerDecisionId: secondRetiredId,
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
      async (applied, direction) => {
        await tx
          .insert(corpusIndexProjectionStates)
          .values(
            applied.flatMap((candidate) => desiredValues(candidate, direction)),
          )
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
      async (reversed, direction) => {
        await tx
          .insert(corpusIndexProjectionStates)
          .values(
            reversed.flatMap((candidate) =>
              desiredValues(candidate, direction),
            ),
          )
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

test("reverse prioritizes a reversible pair over an earlier erased pair", async () => {
  const retiredIds = [
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
  ].toSorted(compareCodeUnit);
  const erasedRetiredId =
    retiredIds.at(0) ?? panic("Reverse fixture requires two retired ids");
  const reversibleRetiredId =
    retiredIds.at(1) ?? panic("Reverse fixture requires two retired ids");
  const erasedCanonicalId = createSafeId<"caseLawDecision">();
  const reversibleCanonicalId = createSafeId<"caseLawDecision">();
  const pairs = [
    {
      canonicalId: erasedCanonicalId,
      docket: "reverse-erased",
      retiredId: erasedRetiredId,
    },
    {
      canonicalId: reversibleCanonicalId,
      docket: "reverse-ready",
      retiredId: reversibleRetiredId,
    },
  ];
  await db.insert(caseLawDecisions).values(
    pairs.flatMap((pair, index) => {
      const { docket } = pair;
      const common = {
        country: "POL",
        court: `Reverse fixture court ${String(index)}`,
        language: "pl",
        caseNumber: `RV ${String(index)}/26`,
        docketFamilyKey: docket,
        decisionDate: "2026-05-06",
        decisionType: "wyrok",
      };
      return [
        {
          ...common,
          id: pair.canonicalId,
          sourceId: courtSource,
          sourceDocumentId: `${docket}-court`,
        },
        {
          ...common,
          id: pair.retiredId,
          sourceId: republisherSource,
          sourceDocumentId: `${docket}-republisher`,
        },
      ];
    }),
  );
  await db.insert(caseLawDecisionSourceIdentities).values(
    pairs.flatMap((pair) => [
      {
        sourceId: courtSource,
        sourceDocumentId: `${pair.docket}-court`,
        decisionId: pair.canonicalId,
        rawOwnerDecisionId: pair.canonicalId,
      },
      {
        sourceId: republisherSource,
        sourceDocumentId: `${pair.docket}-republisher`,
        decisionId: pair.retiredId,
        rawOwnerDecisionId: pair.retiredId,
      },
    ]),
  );
  const candidates = await selectRepublishedDecisionCandidates(db, 100);
  const reverseCandidates = candidates.filter(({ duplicate }) =>
    retiredIds.includes(duplicate.id),
  );
  expect(reverseCandidates).toHaveLength(2);
  await db.transaction(async (tx) => {
    expect(
      await applyRepublishedDecisionBatch(
        tx,
        reverseCandidates,
        async () => undefined,
      ),
    ).toHaveLength(2);
  });
  await db
    .update(caseLawDecisions)
    .set({ redactedAt: new Date("2026-05-07") })
    .where(eq(caseLawDecisions.id, erasedCanonicalId));

  expect(
    await reverseRepublishedDecisionBatch(db, 1, async () => undefined),
  ).toEqual([{ type: "reversed", retiredId: reversibleRetiredId }]);
  expect(
    await reverseRepublishedDecisionBatch(db, 1, async () => undefined),
  ).toEqual([{ type: "refused_erased", retiredId: erasedRetiredId }]);
  expect(
    await db
      .select({ retiredId: caseLawDecisionAliases.retiredDecisionId })
      .from(caseLawDecisionAliases)
      .where(inArray(caseLawDecisionAliases.retiredDecisionId, retiredIds)),
  ).toEqual([{ retiredId: erasedRetiredId }]);
});
