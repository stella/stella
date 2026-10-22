import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { compareCodeUnit } from "@stll/collation";

import {
  caseLawDecisionAliases,
  caseLawDecisionAliasMovedIdentities,
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
  SOURCE_AUTHORITY,
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
      {
        sourceId: republisherSource,
        sourceDocumentId: "publisher-already-canonical",
        decisionId: canonicalId,
        sourceRawS3Key: "raw/already-canonical",
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => await client.close());

test("every adapter has an authority rank", () => {
  for (const adapterKey of Object.values(ADAPTER_KEYS)) {
    expect(SOURCE_AUTHORITY[adapterKey]).toBeOneOf([0, 1]);
  }
});

test(
  "bounded apply pages progress past pairs linked by earlier runs",
  async () => {
    const isolatedClient = await createTestPglite();
    const isolatedDb = drizzle({ client: isolatedClient });
    const officialSource = createSafeId<"caseLawSource">();
    const publisherSource = createSafeId<"caseLawSource">();
    await isolatedDb.insert(caseLawSources).values([
      { id: officialSource, adapterKey: ADAPTER_KEYS.PL_TK, name: "Official" },
      {
        id: publisherSource,
        adapterKey: ADAPTER_KEYS.PL_COURTS,
        name: "Publisher",
      },
    ]);
    const pairs = ["page-one", "page-two"].map((docket, index) => ({
      canonicalId: createSafeId<"caseLawDecision">(),
      docket,
      duplicateId: createSafeId<"caseLawDecision">(),
      index,
    }));
    await isolatedDb.insert(caseLawDecisions).values(
      pairs.flatMap(({ canonicalId: id, docket, duplicateId, index }) => {
        const common = {
          country: "POL",
          court: `Pagination court ${String(index)}`,
          language: "pl",
          caseNumber: `P ${String(index)}/26`,
          docketFamilyKey: docket,
          decisionDate: "2026-07-01",
          decisionType: "wyrok",
        };
        return [
          {
            ...common,
            id,
            sourceId: officialSource,
            sourceDocumentId: `${docket}-official`,
          },
          {
            ...common,
            id: duplicateId,
            sourceId: publisherSource,
            sourceDocumentId: `${docket}-publisher`,
          },
        ];
      }),
    );
    await isolatedDb.insert(caseLawDecisionSourceIdentities).values(
      pairs.map(({ docket, duplicateId }) => ({
        sourceId: publisherSource,
        sourceDocumentId: `${docket}-publisher`,
        decisionId: duplicateId,
      })),
    );

    const applied: SafeId<"caseLawDecision">[] = [];
    for (let page = 0; page < 2; page += 1) {
      const candidates = await selectRepublishedDecisionCandidates(
        isolatedDb,
        1,
      );
      expect(candidates).toHaveLength(1);
      const candidate =
        candidates.at(0) ??
        panic("Pagination fixture must select one candidate");
      await isolatedDb.transaction(async (tx) => {
        const outcomes = await applyRepublishedDecisionBatch(
          tx,
          candidates,
          async () => undefined,
        );
        expect(outcomes).toEqual([
          { type: "linked", retiredId: candidate.duplicate.id },
        ]);
        applied.push(candidate.duplicate.id);
      });
    }
    expect(new Set(applied)).toEqual(
      new Set(pairs.map(({ duplicateId }) => duplicateId)),
    );
    expect(await selectRepublishedDecisionCandidates(isolatedDb, 1)).toEqual(
      [],
    );
    expect(
      (await selectRepublishedDecisionReport(isolatedDb)).outcomes
        .separateAlreadyRetired,
    ).toBe(2);
    await isolatedClient.close();
  },
  { timeout: 120_000 },
);

test(
  "a survivor-refused pair never occupies an actionable page",
  async () => {
    const isolatedClient = await createTestPglite();
    const isolatedDb = drizzle({ client: isolatedClient });
    const officialSource = createSafeId<"caseLawSource">();
    const publisherSource = createSafeId<"caseLawSource">();
    const firstPublisherSource = createSafeId<"caseLawSource">();
    await isolatedDb.insert(caseLawSources).values([
      { id: officialSource, adapterKey: ADAPTER_KEYS.PL_TK, name: "Official" },
      {
        id: publisherSource,
        adapterKey: ADAPTER_KEYS.PL_COURTS,
        name: "Publisher",
      },
      {
        id: firstPublisherSource,
        adapterKey: ADAPTER_KEYS.AT_COURTS,
        name: "First publisher",
      },
    ]);
    const refusedRetiredId = createSafeId<"caseLawDecision">();
    const survivorId = createSafeId<"caseLawDecision">();
    const refusedCanonicalId = createSafeId<"caseLawDecision">();
    const eligibleCanonicalId = createSafeId<"caseLawDecision">();
    const eligibleDuplicateId = createSafeId<"caseLawDecision">();
    const common = (court: string, docketFamilyKey: string) => ({
      country: "POL",
      court,
      language: "pl",
      caseNumber: docketFamilyKey,
      docketFamilyKey,
      decisionDate: "2026-07-02",
      decisionType: "wyrok",
    });
    await isolatedDb.insert(caseLawDecisions).values([
      {
        ...common("Refused court", "retired-docket"),
        id: refusedRetiredId,
        sourceId: firstPublisherSource,
        sourceDocumentId: "retired",
      },
      {
        ...common("Refused court", "refused-docket"),
        id: survivorId,
        sourceId: publisherSource,
        sourceDocumentId: "survivor",
      },
      {
        ...common("Refused court", "refused-docket"),
        id: refusedCanonicalId,
        sourceId: officialSource,
        sourceDocumentId: "refused-canonical",
      },
      {
        ...common("Eligible court", "eligible-docket"),
        id: eligibleCanonicalId,
        sourceId: officialSource,
        sourceDocumentId: "eligible-canonical",
      },
      {
        ...common("Eligible court", "eligible-docket"),
        id: eligibleDuplicateId,
        sourceId: publisherSource,
        sourceDocumentId: "eligible-duplicate",
      },
    ]);
    await isolatedDb.insert(caseLawDecisionSourceIdentities).values({
      sourceId: firstPublisherSource,
      sourceDocumentId: "retired",
      decisionId: survivorId,
    });
    await isolatedDb.insert(caseLawDecisionAliases).values({
      retiredDecisionId: refusedRetiredId,
      canonicalDecisionId: survivorId,
    });

    const candidates = await selectRepublishedDecisionCandidates(isolatedDb, 1);
    expect(candidates).toHaveLength(1);
    expect(candidates.at(0)?.duplicate.id).toBe(eligibleDuplicateId);
    const report = await selectRepublishedDecisionReport(isolatedDb);
    expect(report.outcomes.separateAliasGroupSurvivor).toBe(1);
    await isolatedClient.close();
  },
  { timeout: 120_000 },
);

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
    },
    {
      sourceId: republisherSource,
      sourceDocumentId: "erasure-republisher",
      decisionId: selectedRetiredId,
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
    panic("Erasure fixture must be selected before redaction");
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
    await db
      .select({
        retiredDecisionId:
          caseLawDecisionAliasMovedIdentities.retiredDecisionId,
        sourceDocumentId: caseLawDecisionAliasMovedIdentities.sourceDocumentId,
      })
      .from(caseLawDecisionAliasMovedIdentities),
  ).toEqual([
    { retiredDecisionId: retiredId, sourceDocumentId: "publisher-1" },
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

test("a survivor cannot be retired into a later publication", async () => {
  const firstSource = createSafeId<"caseLawSource">();
  const firstId = createSafeId<"caseLawDecision">();
  const survivorId = createSafeId<"caseLawDecision">();
  const laterId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawSources).values({
    id: firstSource,
    adapterKey: ADAPTER_KEYS.AT_COURTS,
    name: "First republisher",
  });
  const common = {
    country: "POL",
    court: "Chained repair fixture court",
    language: "pl",
    caseNumber: "C 1/26",
    docketFamilyKey: "c:1:26",
    decisionDate: "2026-06-01",
    decisionType: "wyrok",
  };
  await db.insert(caseLawDecisions).values([
    {
      ...common,
      id: firstId,
      sourceId: firstSource,
      sourceDocumentId: "chain-first",
      createdAt: new Date("2026-06-02"),
    },
    {
      ...common,
      id: survivorId,
      sourceId: republisherSource,
      sourceDocumentId: "chain-survivor",
      createdAt: new Date("2026-06-01"),
    },
  ]);
  await db.insert(caseLawDecisionSourceIdentities).values([
    {
      sourceId: firstSource,
      sourceDocumentId: "chain-first",
      decisionId: firstId,
    },
    {
      sourceId: republisherSource,
      sourceDocumentId: "chain-survivor",
      decisionId: survivorId,
    },
  ]);
  const firstCandidate = (
    await selectRepublishedDecisionCandidates(db, 100)
  ).find(({ duplicate }) => duplicate.id === firstId);
  expect(firstCandidate).toBeDefined();
  if (!firstCandidate) {
    panic("Initial chain fixture must be selected");
  }
  await db.transaction(
    async (tx) =>
      await applyRepublishedDecisionBatch(
        tx,
        [firstCandidate],
        async () => undefined,
      ),
  );

  // Keep the retired row out of the next exact-match component. The later
  // court publication would otherwise retire the lower-authority survivor.
  await db
    .update(caseLawDecisions)
    .set({ docketFamilyKey: "retired:c:1:26" })
    .where(eq(caseLawDecisions.id, firstId));
  await db.insert(caseLawDecisions).values({
    ...common,
    id: laterId,
    sourceId: courtSource,
    sourceDocumentId: "chain-later",
    createdAt: new Date("2026-06-03"),
  });
  await db.insert(caseLawDecisionSourceIdentities).values({
    sourceId: courtSource,
    sourceDocumentId: "chain-later",
    decisionId: laterId,
  });
  const refused = (await selectRepublishedDecisionCandidates(db, 100)).find(
    ({ duplicate }) => duplicate.id === survivorId,
  );
  expect(refused).toBeUndefined();
  expect(
    (await selectRepublishedDecisionReport(db)).outcomes
      .separateAliasGroupSurvivor,
  ).toBeGreaterThanOrEqual(1);
  expect(
    await db
      .select({ id: canonicalDecisionIdSql(caseLawDecisions.id) })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, firstId)),
  ).toEqual([{ id: survivorId }]);
  expect(
    await db.transaction(
      async (tx) =>
        await reverseRepublishedDecisionBatch(tx, 1, async () => undefined),
    ),
  ).toEqual([{ type: "reversed", retiredId: firstId }]);
  const fixtureIds = [firstId, survivorId, laterId];
  await db
    .delete(caseLawDecisionSourceIdentities)
    .where(inArray(caseLawDecisionSourceIdentities.decisionId, fixtureIds));
  await db
    .delete(caseLawDecisions)
    .where(inArray(caseLawDecisions.id, fixtureIds));
  await db.delete(caseLawSources).where(eq(caseLawSources.id, firstSource));
});

test("selection excludes a decision that is already retired", async () => {
  const ids = [
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
  ];
  const [retired, survivor, later] = ids;
  if (!retired || !survivor || !later) {
    panic("Retired selection fixture requires three ids");
  }
  const common = {
    country: "POL",
    court: "Retired selection fixture court",
    language: "pl",
    caseNumber: "RS 1/26",
    docketFamilyKey: "rs:1:26",
    decisionDate: "2026-06-02",
    decisionType: "wyrok",
  };
  await db.insert(caseLawDecisions).values([
    {
      ...common,
      id: retired,
      sourceId: republisherSource,
      sourceDocumentId: "retired-selection",
    },
    {
      ...common,
      id: survivor,
      sourceId: republisherSource,
      sourceDocumentId: "retired-survivor",
    },
  ]);
  await db.insert(caseLawDecisionAliases).values({
    retiredDecisionId: retired,
    canonicalDecisionId: survivor,
  });
  await db
    .update(caseLawDecisions)
    .set({ docketFamilyKey: "survivor:rs:1:26" })
    .where(eq(caseLawDecisions.id, survivor));
  await db.insert(caseLawDecisions).values({
    ...common,
    id: later,
    sourceId: courtSource,
    sourceDocumentId: "retired-later",
  });
  const candidate = (await selectRepublishedDecisionCandidates(db, 100)).find(
    ({ duplicate }) => duplicate.id === retired,
  );
  expect(candidate).toBeUndefined();
  expect(
    (await selectRepublishedDecisionReport(db)).outcomes.separateAlreadyRetired,
  ).toBeGreaterThanOrEqual(1);
  await db
    .delete(caseLawDecisionAliases)
    .where(eq(caseLawDecisionAliases.retiredDecisionId, retired));
  await db.delete(caseLawDecisions).where(inArray(caseLawDecisions.id, ids));
});

test("apply rechecks retirement after candidate selection", async () => {
  const selectedRetiredId = createSafeId<"caseLawDecision">();
  const selectedCanonicalId = createSafeId<"caseLawDecision">();
  const concurrentCanonicalId = createSafeId<"caseLawDecision">();
  const common = {
    country: "POL",
    court: "Concurrent repair fixture court",
    language: "pl",
    caseNumber: "CR 1/26",
    docketFamilyKey: "cr:1:26",
    decisionDate: "2026-06-03",
    decisionType: "wyrok",
  };
  await db.insert(caseLawDecisions).values([
    {
      ...common,
      id: selectedRetiredId,
      sourceId: republisherSource,
      sourceDocumentId: "concurrent-retired",
    },
    {
      ...common,
      id: selectedCanonicalId,
      sourceId: courtSource,
      sourceDocumentId: "concurrent-selected",
    },
    {
      ...common,
      id: concurrentCanonicalId,
      sourceId: republisherSource,
      sourceDocumentId: "concurrent-winner",
      docketFamilyKey: "concurrent:winner",
    },
  ]);
  await db.insert(caseLawDecisionSourceIdentities).values({
    sourceId: republisherSource,
    sourceDocumentId: "concurrent-retired",
    decisionId: selectedRetiredId,
  });
  const candidate = (await selectRepublishedDecisionCandidates(db, 100)).find(
    ({ duplicate }) => duplicate.id === selectedRetiredId,
  );
  expect(candidate?.disposition).toBe("link");
  if (!candidate) {
    panic("Concurrent fixture must be selected before retirement");
  }
  await db.insert(caseLawDecisionAliases).values({
    retiredDecisionId: selectedRetiredId,
    canonicalDecisionId: concurrentCanonicalId,
  });
  expect(
    await db.transaction(
      async (tx) =>
        await applyRepublishedDecisionBatch(tx, [candidate], async () =>
          panic("A concurrently retired candidate must not be reconciled"),
        ),
    ),
  ).toEqual([
    { type: "separate_already_retired", retiredId: selectedRetiredId },
  ]);
  await db
    .delete(caseLawDecisionAliases)
    .where(eq(caseLawDecisionAliases.retiredDecisionId, selectedRetiredId));
  await db
    .delete(caseLawDecisionSourceIdentities)
    .where(eq(caseLawDecisionSourceIdentities.decisionId, selectedRetiredId));
  await db
    .delete(caseLawDecisions)
    .where(
      inArray(caseLawDecisions.id, [
        selectedRetiredId,
        selectedCanonicalId,
        concurrentCanonicalId,
      ]),
    );
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

test("reverse prioritizes a reversible pair and refuses erased or unrestorable pairs", async () => {
  const retiredIds = [
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
    createSafeId<"caseLawDecision">(),
  ].toSorted(compareCodeUnit);
  const erasedRetiredId =
    retiredIds.at(0) ?? panic("Reverse fixture requires three retired ids");
  const unrestorableRetiredId =
    retiredIds.at(1) ?? panic("Reverse fixture requires three retired ids");
  const reversibleRetiredId =
    retiredIds.at(2) ?? panic("Reverse fixture requires three retired ids");
  const erasedCanonicalId = createSafeId<"caseLawDecision">();
  const unrestorableCanonicalId = createSafeId<"caseLawDecision">();
  const reversibleCanonicalId = createSafeId<"caseLawDecision">();
  const pairs = [
    {
      canonicalId: erasedCanonicalId,
      docket: "reverse-erased",
      retiredId: erasedRetiredId,
    },
    {
      canonicalId: unrestorableCanonicalId,
      docket: "reverse-unrestorable",
      retiredId: unrestorableRetiredId,
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
      },
      {
        sourceId: republisherSource,
        sourceDocumentId: `${pair.docket}-republisher`,
        decisionId: pair.retiredId,
      },
    ]),
  );
  // A second republisher identity: reverse must restore both or neither.
  await db.insert(caseLawDecisionSourceIdentities).values({
    sourceId: republisherSource,
    sourceDocumentId: "reverse-unrestorable-republisher-mirror",
    decisionId: unrestorableRetiredId,
  });
  const candidates = await selectRepublishedDecisionCandidates(db, 100);
  const reverseCandidates = candidates.filter(({ duplicate }) =>
    retiredIds.includes(duplicate.id),
  );
  expect(reverseCandidates).toHaveLength(3);
  await db.transaction(async (tx) => {
    expect(
      await applyRepublishedDecisionBatch(
        tx,
        reverseCandidates,
        async () => undefined,
      ),
    ).toHaveLength(3);
  });
  await db
    .update(caseLawDecisions)
    .set({ redactedAt: new Date("2026-05-07") })
    .where(eq(caseLawDecisions.id, erasedCanonicalId));
  await db
    .delete(caseLawDecisionSourceIdentities)
    .where(
      eq(
        caseLawDecisionSourceIdentities.sourceDocumentId,
        "reverse-unrestorable-republisher",
      ),
    );

  const reconciled: SafeId<"caseLawDecision">[] = [];
  const recordReconciled = async (
    batch: readonly RepublishedDecisionCandidate[],
  ) => {
    reconciled.push(...batch.map(({ duplicate }) => duplicate.id));
  };
  expect(
    await reverseRepublishedDecisionBatch(db, 1, recordReconciled),
  ).toEqual([{ type: "reversed", retiredId: reversibleRetiredId }]);
  expect(
    await reverseRepublishedDecisionBatch(db, 2, recordReconciled),
  ).toEqual([
    { type: "refused_erased", retiredId: erasedRetiredId },
    { type: "refused_unrestorable", retiredId: unrestorableRetiredId },
  ]);
  expect(reconciled).toEqual([reversibleRetiredId]);
  expect(
    await db
      .select({ retiredId: caseLawDecisionAliases.retiredDecisionId })
      .from(caseLawDecisionAliases)
      .where(inArray(caseLawDecisionAliases.retiredDecisionId, retiredIds))
      .orderBy(caseLawDecisionAliases.retiredDecisionId),
  ).toEqual([
    { retiredId: erasedRetiredId },
    { retiredId: unrestorableRetiredId },
  ]);
  expect(
    await db
      .select({ decisionId: caseLawDecisionSourceIdentities.decisionId })
      .from(caseLawDecisionSourceIdentities)
      .where(
        eq(
          caseLawDecisionSourceIdentities.sourceDocumentId,
          "reverse-unrestorable-republisher-mirror",
        ),
      ),
  ).toEqual([{ decisionId: unrestorableCanonicalId }]);
});
