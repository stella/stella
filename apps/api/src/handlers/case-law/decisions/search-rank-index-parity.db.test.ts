import type { PGlite } from "@electric-sql/pglite";
import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { rehydrateCaseLawCandidates } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { CITATION_AUTHORITY_BUCKET_MAX_ERROR } from "@/api/lib/legal-search/case-law-ranking-signals";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import type { ScannedProjection } from "@/api/lib/legal-search/corpus-index-pagination";
import { buildCaseLawProjectionDocuments } from "@/api/lib/legal-search/corpus-index-projection-builder";
import { readCaseLawRankingSignals } from "@/api/lib/legal-search/corpus-index-projection-ranking-signals";
import { corpusIndexId } from "@/api/lib/legal-search/index-naming";
import { DEFAULT_AUTHORITY_WEIGHT } from "@/api/lib/legal-search/rerank";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

/**
 * The same candidates ranked twice: once from the database rows the
 * per-candidate read returns, once from the passages case_law_v10 writes for
 * the same decisions. The two may only differ where the bucketed authority
 * moves a blend by less than its stated bound.
 */
const GENERATION = "case_law_v10";
const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v10;
const FINGERPRINT = "a".repeat(64);
const LONG_TEXT = `${"první ".repeat(400)}\n\n${"druhý ".repeat(400)}`;
/** Two decisions' blends may swap only when they sat this close. */
const SWAP_BOUND =
  2 * DEFAULT_AUTHORITY_WEIGHT * CITATION_AUTHORITY_BUCKET_MAX_ERROR;

const sourceId = createSafeId<"caseLawSource">();

type Fixture = {
  court: string;
  authority: number;
  group: string | null;
  language?: string;
  text: string;
};

/** Courts of several tiers, authorities across many buckets, shared groups. */
const FIXTURES: readonly Fixture[] = [
  { court: "Nejvyšší soud", authority: 0, group: "g-1", text: "Krátký text" },
  { court: "Ústavní soud", authority: 1.7, group: "g-2", text: LONG_TEXT },
  {
    court: "Okresní soud v Kolíně",
    authority: 0.3,
    group: "g-3",
    text: "Krátký text",
  },
  {
    court: "Krajský soud v Brně",
    authority: 0.9,
    group: "g-4",
    text: LONG_TEXT,
  },
  { court: "Synthetic court", authority: 4, group: "g-5", text: "Krátký text" },
  // Versions of one judgment: each shares its group.
  { court: "Nejvyšší soud", authority: 2.5, group: "g-6", text: "Krátký text" },
  {
    court: "Nejvyšší soud",
    authority: 2.5,
    group: "g-6",
    language: "en",
    text: "Short text",
  },
  {
    court: "Okresní soud v Kolíně",
    authority: 0.0004,
    group: null,
    text: "Krátký text",
  },
  {
    court: "Nejvyšší správní soud",
    authority: 0.31,
    group: "g-9",
    text: LONG_TEXT,
  },
  {
    court: "Krajský soud v Brně",
    authority: 0.305,
    group: "g-10",
    text: "Krátký text",
  },
];

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;
const ids = FIXTURES.map(() => createSafeId<"caseLawDecision">());
const projections = new Map<string, ScannedProjection>();

// timeout: builds the PGlite schema, then projects every fixture decision.
beforeAll(async () => {
  client = await createTestPglite();
  const db = drizzle({ client });
  const readDb = async <T>(
    fn: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await withPublicLawReaderRole(db, async (roleTx) => {
      // SAFETY: the role transaction supplies the select surface the reads use.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
      const tx = roleTx as unknown as CaseLawPublicReadTransaction;
      return await fn(tx);
    });
  // SAFETY: brand-only wrapper; the reads never inspect the marker.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the branded handle carries no behaviour
  caseLawDb = readDb as unknown as CaseLawPublicReadDb;

  await db
    .insert(caseLawSources)
    .values([
      caseLawSourceRow({ adapterKey: "open", id: sourceId, name: "open" }),
    ]);
  await db.insert(caseLawDecisions).values(
    FIXTURES.map((fixture, index) => ({
      id: ids[index] ?? panic("Fixture without id"),
      sourceId,
      caseNumber: `${String(index + 1)} Cdo 1/2026`,
      citationAuthority: fixture.authority,
      court: fixture.court,
      country: "CZE",
      language: fixture.language ?? "cs",
      languageGroupKey: fixture.group,
      contentHash: "index-parity",
    })),
  );
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "building",
  });
  const signals = await db.transaction(
    async (tx) =>
      await readCaseLawRankingSignals(asTestRaw<Transaction>(tx), ids),
  );
  const appliedAt = new Date();
  const indexId = corpusIndexId(GENERATION, "CZE");
  for (const [index, fixture] of FIXTURES.entries()) {
    const id = ids[index] ?? panic("Fixture without id");
    const revision = createSafeId<"corpusIndexProjectionIntent">();
    const documents = buildCaseLawProjectionDocuments({
      manifest: MANIFEST,
      input: {
        family: "case_law",
        documentId: id,
        sourceId,
        jurisdiction: "CZE",
        language: fixture.language ?? "cs",
        documentType: null,
        contentHash: "index-parity",
        redistributionEligible: true,
        redacted: false,
        listingOnly: false,
        provisionKeys: [],
        rankingSignals: signals.get(id) ?? panic("No signals for a fixture"),
        vacatedFrom: null,
        caseNumber: `${String(index + 1)} Cdo 1/2026`,
        identifiers: [],
        court: fixture.court,
        courtId: null,
        decisionDate: null,
        ecli: null,
        metadata: null,
      },
      payload: { text: fixture.text, ast: null },
      revision,
    });
    // db-await-in-loop: ten fixture rows, each with its own passage count.
    await db.insert(corpusIndexProjectionIntents).values({
      id: revision,
      family: "case_law",
      generation: GENERATION,
      entityId: id,
      epoch: 1n,
      fingerprint: FINGERPRINT,
      indexId,
      status: "applied",
      appendStartedAt: appliedAt,
      appendCommittedAt: appliedAt,
      expectedDocumentCount: documents.length,
      appliedAt,
    });
    // db-await-in-loop: ten fixture rows, each naming its own revision.
    await db.insert(corpusIndexProjectionStates).values({
      family: "case_law",
      generation: GENERATION,
      entityId: id,
      desiredAction: "upsert",
      desiredEpoch: 1n,
      desiredFingerprint: FINGERPRINT,
      desiredIndexId: indexId,
      appliedAction: "upsert",
      appliedEpoch: 1n,
      appliedRevision: revision,
      appliedFingerprint: FINGERPRINT,
      appliedIndexId: indexId,
      appliedAt,
    });
    // The scan reaches a decision by whichever passage ranks first; any of
    // them carries the same signals.
    const reached = documents.at(-1) ?? panic("A decision without passages");
    projections.set(id, { revision, fields: reached });
  }
}, 120_000);

afterAll(async () => {
  await client.close();
});

/** A deterministic sequence of lexical position scores. */
const scoreSequence = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return Math.exp(-(state % 600) / 300);
  };
};

const rank = async (
  candidates: { id: string; score: number }[],
  indexed: boolean,
) =>
  await rehydrateCaseLawCandidates({
    body: { country: "CZE", query: "index parity" },
    candidates,
    caseLawDb,
    courtWeights: courtWeightMapFromSeed(),
    generation: GENERATION,
    indexedProjections: indexed ? projections : undefined,
  });

test("the index ranks a candidate set as the database does, within the bucket bound", async () => {
  let differingScores = 0;
  for (let trial = 0; trial < 40; trial += 1) {
    const next = scoreSequence(trial + 1);
    const candidates = ids.map((id) => ({ id, score: next() }));
    // db-await-in-loop: forty independent trials, each one ranking twice.
    const database = await rank(candidates, false);
    // db-await-in-loop: the indexed ranking reads no database at all.
    const indexed = await rank(candidates, true);

    // The same decisions stand, fold the same way, may recur the same way,
    // and name the same copy.
    expect(new Set(indexed.ranked.map(({ id }) => id))).toEqual(
      new Set(database.ranked.map(({ id }) => id)),
    );
    expect(new Set(indexed.groups)).toEqual(new Set(database.groups));
    expect(indexed.revisionById).toEqual(database.revisionById);
    expect(indexed.rehydratedCandidateCount).toBe(
      database.rehydratedCandidateCount,
    );

    const exact = new Map(database.ranked.map((hit) => [hit.id, hit.score]));
    const position = new Map(database.ranked.map((hit, at) => [hit.id, at]));
    for (const hit of indexed.ranked) {
      const score = exact.get(hit.id) ?? panic("A hit the database dropped");
      expect(Math.abs(hit.score - score)).toBeLessThanOrEqual(
        SWAP_BOUND / 2 + Number.EPSILON,
      );
      if (hit.score !== score) {
        differingScores += 1;
      }
    }
    // Any pair the two orders disagree on sat within the bound.
    for (const [at, left] of indexed.ranked.entries()) {
      for (const right of indexed.ranked.slice(at + 1)) {
        const leftAt = position.get(left.id) ?? panic("Unranked id");
        const rightAt = position.get(right.id) ?? panic("Unranked id");
        if (leftAt > rightAt) {
          expect(
            Math.abs((exact.get(left.id) ?? 0) - (exact.get(right.id) ?? 0)),
          ).toBeLessThanOrEqual(SWAP_BOUND + Number.EPSILON);
        }
      }
    }
  }
  // The fixture reaches the fault: bucketing moved real blends.
  expect(differingScores).toBeGreaterThan(0);
});

test("a hit without a well-formed signal set is excluded, not ranked on a guess", async () => {
  const [first, second] = ids;
  if (first === undefined || second === undefined) {
    return panic("Fixture ids missing");
  }
  const original = projections.get(first) ?? panic("No projection");
  projections.set(first, {
    ...original,
    fields: { ...original.fields, citation_authority_bucket: "7" },
  });
  try {
    const indexed = await rank(
      [
        { id: first, score: 1 },
        { id: second, score: 0.9 },
      ],
      true,
    );
    expect(indexed.ranked.map(({ id }) => id)).toEqual([second]);
  } finally {
    projections.set(first, original);
  }
});
