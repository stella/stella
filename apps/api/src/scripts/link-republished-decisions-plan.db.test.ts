import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { compareCodeUnit } from "@stll/collation";

import {
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { canonicalDecisionIdSql } from "@/api/lib/case-law/decision-alias";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  applyRepublishedDecisionBatch,
  reverseRepublishedDecisionBatch,
  selectRepublishedDecisionCandidates,
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
