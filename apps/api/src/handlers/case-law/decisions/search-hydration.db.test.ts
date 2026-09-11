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
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
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

const GENERATION = "case_law_v5";
/** A second generation, holding a different set of decisions. */
const OTHER_GENERATION = "case_law_v6";
const INDEX_ID = corpusIndexId(GENERATION, "CZE");
const OTHER_INDEX_ID = corpusIndexId(OTHER_GENERATION, "CZE");
const APPLIED_FINGERPRINT = "a".repeat(64);
const DESIRED_FINGERPRINT = "b".repeat(64);
const sourceId = createSafeId<"caseLawSource">();
const closedSourceId = createSafeId<"caseLawSource">();
const czechId = createSafeId<"caseLawDecision">();
const slovakId = createSafeId<"caseLawDecision">();
const foreignId = createSafeId<"caseLawDecision">();
const closedId = createSafeId<"caseLawDecision">();
const projectedId = createSafeId<"caseLawDecision">();
const queuedId = createSafeId<"caseLawDecision">();
const czechIntentId = createSafeId<"corpusIndexProjectionIntent">();
const slovakIntentId = createSafeId<"corpusIndexProjectionIntent">();
const closedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const projectedIntentId = createSafeId<"corpusIndexProjectionIntent">();
const queuedIntentId = createSafeId<"corpusIndexProjectionIntent">();

/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;
const SEARCH_BODY = { country: "CZE", query: "promlčení" } as const;

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

type HeldProjectionOptions = {
  entityId: string;
  generation: string;
  indexId: string;
  intentId: SafeId<"corpusIndexProjectionIntent">;
};

/**
 * One decision a generation holds: applied equals desired on every field the
 * read compares, in the index the generation routes the decision's country to.
 */
const heldProjection = ({
  entityId,
  generation,
  indexId,
  intentId,
}: HeldProjectionOptions) => {
  const appliedAt = new Date();
  return {
    intent: {
      id: intentId,
      family: "case_law" as const,
      generation,
      entityId,
      epoch: 1n,
      fingerprint: APPLIED_FINGERPRINT,
      indexId,
      status: "applied" as const,
      appendStartedAt: appliedAt,
      appendCommittedAt: appliedAt,
      expectedDocumentCount: 1,
      appliedAt,
    },
    state: {
      family: "case_law" as const,
      generation,
      entityId,
      desiredAction: "upsert" as const,
      desiredEpoch: 1n,
      desiredFingerprint: APPLIED_FINGERPRINT,
      desiredIndexId: indexId,
      appliedAction: "upsert" as const,
      appliedEpoch: 1n,
      appliedRevision: intentId,
      appliedFingerprint: APPLIED_FINGERPRINT,
      appliedIndexId: indexId,
      appliedAt,
    },
  };
};

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
        citationAuthority: 2,
        citationCount: 7,
        metadata: { legalSentence: "Právní věta." },
      },
      {
        id: slovakId,
        sourceId,
        caseNumber: "22 Cdo 1/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "sk",
        languageGroupKey: "hydration-group",
        contentHash: "hash-svk",
        citationAuthority: 1,
        citationCount: 3,
      },
      {
        id: foreignId,
        sourceId,
        caseNumber: "1 Cdo 2/2026",
        court: "Najvyšší súd",
        country: "SVK",
        language: "sk",
        contentHash: "hash-foreign",
        indexedHash: "hash-foreign",
      },
      {
        id: closedId,
        sourceId: closedSourceId,
        caseNumber: "1 Afs 2/2026",
        court: "Nejvyšší správní soud",
        country: "CZE",
        language: "cs",
        contentHash: "hash-closed",
      },
      {
        id: projectedId,
        sourceId,
        caseNumber: "30 Cdo 3/2026",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "projected-group",
        contentHash: "hash-projected",
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
      },
    ]);

    await db.insert(corpusIndexGenerations).values(
      ([GENERATION, OTHER_GENERATION] as const).map((generation) => ({
        family: "case_law" as const,
        generation,
        cluster: "q09" as const,
        manifestDigest: corpusIndexManifestDigest(
          CORPUS_INDEX_MANIFESTS[generation],
        ),
        status: "building" as const,
      })),
    );

    // What a generation holds is stated by its projection state alone.
    const held = [
      {
        entityId: czechId,
        generation: GENERATION,
        indexId: INDEX_ID,
        intentId: czechIntentId,
      },
      {
        entityId: slovakId,
        generation: GENERATION,
        indexId: INDEX_ID,
        intentId: slovakIntentId,
      },
      {
        entityId: closedId,
        generation: GENERATION,
        indexId: INDEX_ID,
        intentId: closedIntentId,
      },
      {
        entityId: projectedId,
        generation: OTHER_GENERATION,
        indexId: OTHER_INDEX_ID,
        intentId: projectedIntentId,
      },
    ].map(heldProjection);
    const queuedAt = new Date();
    await db.insert(corpusIndexProjectionIntents).values([
      ...held.map(({ intent }) => intent),
      {
        id: queuedIntentId,
        family: "case_law",
        generation: OTHER_GENERATION,
        entityId: queuedId,
        epoch: 1n,
        fingerprint: APPLIED_FINGERPRINT,
        indexId: OTHER_INDEX_ID,
        status: "applied",
        appendStartedAt: queuedAt,
        appendCommittedAt: queuedAt,
        expectedDocumentCount: 1,
        appliedAt: queuedAt,
      },
    ]);
    await db.insert(corpusIndexProjectionStates).values([
      ...held.map(({ state }) => state),
      // The applied revision is behind a queued content change, so what the
      // engine holds for this decision is not what the generation wants.
      {
        family: "case_law",
        generation: OTHER_GENERATION,
        entityId: queuedId,
        desiredAction: "upsert",
        desiredEpoch: 2n,
        desiredFingerprint: DESIRED_FINGERPRINT,
        desiredIndexId: OTHER_INDEX_ID,
        appliedAction: "upsert",
        appliedEpoch: 1n,
        appliedRevision: queuedIntentId,
        appliedFingerprint: APPLIED_FINGERPRINT,
        appliedIndexId: OTHER_INDEX_ID,
        appliedAt: queuedAt,
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
    body: SEARCH_BODY,
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
    body: SEARCH_BODY,
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
    body: SEARCH_BODY,
    candidates: candidatesOf(czechId, slovakId),
    caseLawDb,
    courtWeights,
    generation: GENERATION,
    hydrated,
  });
  expect(reads).toBe(2);

  // A round that adds nothing new asks the database for nothing at all.
  await rehydrateCaseLawCandidates({
    body: SEARCH_BODY,
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
    body: SEARCH_BODY,
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
    body: SEARCH_BODY,
    caseLawDb,
    generation: GENERATION,
    ids: [],
  });

  expect(rows.size).toBe(0);
  expect(reads).toBe(0);
});

test("a generation admits exactly what its projection state holds", async () => {
  const scoped = {
    body: SEARCH_BODY,
    caseLawDb,
    courtWeights,
    generation: OTHER_GENERATION,
  };

  const ranking = await rehydrateCaseLawCandidates({
    ...scoped,
    candidates: candidatesOf(projectedId, queuedId, czechId),
  });
  // Applied equals desired for the first decision. The second still owes the
  // index a mutation, and the third has no state row in this generation.
  expect(ranking.ranked.map((hit) => hit.id)).toEqual([projectedId]);

  const rows = await readCaseLawPageDecisionRows({
    body: scoped.body,
    caseLawDb,
    generation: OTHER_GENERATION,
    ids: [projectedId, queuedId, czechId],
  });
  expect([...rows.keys()]).toEqual([projectedId]);
});

test("a generation admits nothing another generation holds", async () => {
  const ranking = await rehydrateCaseLawCandidates({
    body: SEARCH_BODY,
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
    candidates: candidatesOf(czechId, foreignId, closedId),
  });
  // The foreign decision no longer matches the country filter, and the closed
  // source is not redistributable, so neither can stand for the judgment.
  expect(ranking.ranked.map((hit) => hit.id)).toEqual([czechId]);

  const rows = await readCaseLawPageDecisionRows({
    ...scoped,
    ids: [czechId, foreignId, closedId],
  });
  expect([...rows.keys()]).toEqual([czechId]);
});
