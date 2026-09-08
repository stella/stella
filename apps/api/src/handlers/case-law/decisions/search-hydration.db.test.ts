import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import {
  readCaseLawPageDecisionRows,
  rehydrateCaseLawCandidates,
} from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * Search reads Postgres twice per request. The blend read answers for every
 * candidate the scan reaches — a few hundred per request — and carries only
 * what ranking and the language fold consume. The page read answers for the
 * ids the page emits and carries what a result card shows. These tests hold
 * the split: what each read returns, that the request's filters bind on both,
 * and that a candidate is read once however many rounds the scan spends.
 */

const GENERATION = "case_law_v3";
/** A generation the final projection builds: its state row is authoritative. */
const PROJECTED_GENERATION = "case_law_v6";
const PROJECTED_INDEX_ID = corpusIndexId(PROJECTED_GENERATION, "CZE");
const APPLIED_FINGERPRINT = "a".repeat(64);
const DESIRED_FINGERPRINT = "b".repeat(64);
const sourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const czechId = createSafeId<"caseLawDecision">();
const slovakId = createSafeId<"caseLawDecision">();
const closedId = createSafeId<"caseLawDecision">();
const projectedId = createSafeId<"caseLawDecision">();
const queuedId = createSafeId<"caseLawDecision">();
const projectedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const queuedIntentId = createSafeId<"corpusIndexProjectionIntent">();

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;
let reads: number;

/** The request's record of blend rows, as the handler holds it. */
type HydratedRows = NonNullable<
  Parameters<typeof rehydrateCaseLawCandidates>[0]["hydrated"]
>;

const candidatesOf = (...ids: string[]) => ids.map((id) => ({ id, score: 1 }));

/** The registry as a request holds it, without a database to read it from. */
const courtWeights = courtWeightMapFromSeed();

beforeAll(
  async () => {
    client = await createTestPglite();
    const db = drizzle({ client });
    const readDb = async <T>(
      fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) => {
      reads += 1;
      return await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await fn(tx);
      });
    };
    // SAFETY: brand-only wrapper; the reads never inspect the marker.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db.insert(caseLawSources).values([
      caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
      caseLawSourceRow({
        adapterKey: "closed",
        descriptor: {
          allowsDerivedAi: false,
          allowsRedistribution: false,
          attribution: null,
          license: "restricted",
        },
        id: closedSourceId,
        name: "closed",
      }),
    ]);
    // `indexed_hash = content_hash` with no projection row is the legacy
    // serving marker the rehydration filter accepts.
    await db.insert(caseLawDecisions).values([
      {
        id: czechId,
        sourceId,
        caseNumber: "22 Cdo 1/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "hydration-group",
        contentHash: "hash-cze",
        indexedHash: "hash-cze",
        citationAuthority: 2,
        citationCount: 7,
        metadata: { legalSentence: "Právní věta." },
      },
      {
        id: slovakId,
        sourceId,
        caseNumber: "22 Cdo 1/2026",
        court: "Najvyšší súd",
        country: "SVK",
        language: "sk",
        languageGroupKey: "hydration-group",
        contentHash: "hash-svk",
        indexedHash: "hash-svk",
        citationAuthority: 1,
        citationCount: 3,
      },
      {
        id: closedId,
        sourceId: closedSourceId,
        caseNumber: "1 Afs 2/2026",
        court: "Nejvyšší správní soud",
        country: "CZE",
        language: "cs",
        contentHash: "hash-closed",
        indexedHash: "hash-closed",
      },
    ]);

    // A generation the final projection builds writes no projection row and
    // never sets the serving marker: what it holds is stated by its
    // projection state alone.
    await db.insert(corpusIndexGenerations).values({
      family: "case_law",
      generation: PROJECTED_GENERATION,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS[PROJECTED_GENERATION],
      ),
      status: "building",
    });
    await db.insert(caseLawDecisions).values([
      {
        id: projectedId,
        sourceId,
        caseNumber: "30 Cdo 3/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "projected-group",
        contentHash: "hash-projected",
        indexedHash: null,
      },
      {
        id: queuedId,
        sourceId,
        caseNumber: "30 Cdo 4/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "queued-group",
        contentHash: "hash-queued",
        indexedHash: null,
      },
    ]);
    await db.insert(corpusIndexProjectionIntents).values(
      [
        { id: projectedIntentId, entityId: projectedId },
        { id: queuedIntentId, entityId: queuedId },
      ].map(({ id, entityId }) => ({
        id,
        family: "case_law" as const,
        generation: PROJECTED_GENERATION,
        entityId,
        epoch: 1n,
        fingerprint: APPLIED_FINGERPRINT,
        indexId: PROJECTED_INDEX_ID,
        status: "applied" as const,
        appendStartedAt: new Date(),
        appendCommittedAt: new Date(),
        expectedDocumentCount: 1,
        appliedAt: new Date(),
      })),
    );
    await db.insert(corpusIndexProjectionStates).values([
      {
        family: "case_law",
        generation: PROJECTED_GENERATION,
        entityId: projectedId,
        desiredAction: "upsert",
        desiredEpoch: 1n,
        desiredFingerprint: APPLIED_FINGERPRINT,
        desiredIndexId: PROJECTED_INDEX_ID,
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: projectedIntentId,
        appliedFingerprint: APPLIED_FINGERPRINT,
        appliedIndexId: PROJECTED_INDEX_ID,
        appliedAt: new Date(),
      },
      // The applied revision is behind a queued content change, so what the
      // engine holds for this decision is not what the generation wants.
      {
        family: "case_law",
        generation: PROJECTED_GENERATION,
        entityId: queuedId,
        desiredAction: "upsert",
        desiredEpoch: 2n,
        desiredFingerprint: DESIRED_FINGERPRINT,
        desiredIndexId: PROJECTED_INDEX_ID,
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: queuedIntentId,
        appliedFingerprint: APPLIED_FINGERPRINT,
        appliedIndexId: PROJECTED_INDEX_ID,
        appliedAt: new Date(),
      },
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

beforeEach(() => {
  reads = 0;
});

afterAll(async () => {
  await client.close();
});

test("the blend read carries what ranking and the fold need, and nothing a card shows", async () => {
  const hydrated: HydratedRows = new Map();
  const ranking = await rehydrateCaseLawCandidates({
    body: { query: "promlčení" },
    candidates: candidatesOf(czechId, slovakId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
  });

  // Two language versions of one judgment fold into their best-blended member.
  expect(ranking.ranked.map((hit) => hit.id)).toEqual([czechId]);
  expect(ranking.ranked.at(0)?.citationAuthority).toBe(2);
  expect([...hydrated.keys()].toSorted()).toEqual(
    [czechId, slovakId].toSorted(),
  );
  for (const row of hydrated.values()) {
    expect(Object.keys(row ?? {}).toSorted()).toEqual([
      "citationAuthority",
      "country",
      "court",
      "id",
      "languageGroupKey",
    ]);
  }
});

test("a candidate is read once however many rounds ask for it", async () => {
  const hydrated: HydratedRows = new Map();
  await rehydrateCaseLawCandidates({
    body: { query: "promlčení" },
    candidates: candidatesOf(czechId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
  });
  expect(reads).toBe(1);

  // The second round accumulates the first round's candidates plus one more:
  // only the new id may reach the database.
  await rehydrateCaseLawCandidates({
    body: { query: "promlčení" },
    candidates: candidatesOf(czechId, slovakId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
  });
  expect(reads).toBe(2);

  // A round that adds nothing new asks the database for nothing at all.
  await rehydrateCaseLawCandidates({
    body: { query: "promlčení" },
    candidates: candidatesOf(czechId, slovakId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
  });
  expect(reads).toBe(2);
});

test("the page read carries what a result card shows, for the page ids only", async () => {
  const rows = await readCaseLawPageDecisionRows({
    body: { query: "promlčení" },
    caseLawDb,
    generation: GENERATION,
    ids: [czechId],
  });

  expect([...rows.keys()]).toEqual([czechId]);
  const row = rows.get(czechId);
  expect(row?.caseNumber).toBe("22 Cdo 1/2026");
  expect(row?.court).toBe("Nejvyšší soud");
  expect(row?.citationCount).toBe(7);
  // The publisher summary is SQL over `metadata`, and it is the reason the
  // wide row is worth reading only for the ids the page emits.
  expect(row?.headnote).toBe("Právní věta.");
});

test("an empty page reads nothing", async () => {
  const rows = await readCaseLawPageDecisionRows({
    body: { query: "promlčení" },
    caseLawDb,
    generation: GENERATION,
    ids: [],
  });

  expect(rows.size).toBe(0);
  expect(reads).toBe(0);
});

test("a final-projection generation admits exactly what its projection state holds", async () => {
  const scoped = {
    body: { query: "promlčení" },
    caseLawDb,
    courtWeights,
    generation: PROJECTED_GENERATION,
  };

  const ranking = await rehydrateCaseLawCandidates({
    ...scoped,
    candidates: candidatesOf(projectedId, queuedId, czechId),
  });
  // Applied equals desired for the first decision, though it carries no
  // serving marker at all. The second still owes the index a mutation, and
  // the third has no state row in this generation, which is not something a
  // marker on the decision may answer for.
  expect(ranking.ranked.map((hit) => hit.id)).toEqual([projectedId]);

  const rows = await readCaseLawPageDecisionRows({
    body: scoped.body,
    caseLawDb,
    generation: PROJECTED_GENERATION,
    ids: [projectedId, queuedId, czechId],
  });
  expect([...rows.keys()]).toEqual([projectedId]);
});

test("a legacy generation still reads the projection row and the serving marker", async () => {
  const ranking = await rehydrateCaseLawCandidates({
    body: { query: "promlčení" },
    candidates: candidatesOf(projectedId, czechId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
  });

  expect(ranking.ranked.map((hit) => hit.id)).toEqual([czechId]);
});

test("both reads reapply the request filters and the redistribution boundary", async () => {
  const scoped = {
    body: { country: "CZE", query: "promlčení" },
    caseLawDb,
    courtWeights,
    generation: GENERATION,
  };

  const ranking = await rehydrateCaseLawCandidates({
    ...scoped,
    candidates: candidatesOf(czechId, slovakId, closedId),
  });
  // The Slovak version no longer matches the country filter, and the closed
  // source is not redistributable, so neither can stand for the judgment.
  expect(ranking.ranked.map((hit) => hit.id)).toEqual([czechId]);

  const rows = await readCaseLawPageDecisionRows({
    ...scoped,
    ids: [czechId, slovakId, closedId],
  });
  expect([...rows.keys()]).toEqual([czechId]);
});
