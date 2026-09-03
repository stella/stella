import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { rehydrateCaseLawCandidates } from "@/api/handlers/case-law/decisions/search";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const GENERATION = "case_law_v3";
/** Same budget as the schema push: an embedded Postgres is not fast. */
const DB_TEST_TIMEOUT_MS = 120_000;

const sourceId = createSafeId<"caseLawSource">();
const supremeId = createSafeId<"caseLawDecision">();
const districtId = createSafeId<"caseLawDecision">();
const groupCsId = createSafeId<"caseLawDecision">();
const groupEnId = createSafeId<"caseLawDecision">();

let client: PGlite;
let caseLawDb: CaseLawPublicReadDb;

const rank = async (candidates: { id: string; score: number }[]) =>
  await rehydrateCaseLawCandidates({
    body: { query: "search rank" },
    candidates,
    caseLawDb,
    courtWeights: courtWeightMapFromSeed(),
    generation: GENERATION,
  });

beforeAll(
  async () => {
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
    // No projection row for this generation, so the legacy marker decides:
    // an indexed hash equal to the content hash is a current row.
    const indexed = { contentHash: "rank-hash", indexedHash: "rank-hash" };
    await db.insert(caseLawDecisions).values([
      {
        ...indexed,
        id: supremeId,
        sourceId,
        caseNumber: "23 Cdo 1/2026",
        // Published last week: nothing has had the chance to cite it.
        citationAuthority: 0,
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        languageGroupKey: "rank-supreme",
      },
      {
        ...indexed,
        id: districtId,
        sourceId,
        caseNumber: "8 C 1/2019",
        // Cited, but lightly: the tier prior is deliberately small enough
        // that a decision the field actually relies on keeps its place.
        citationAuthority: 0.3,
        court: "Okresní soud v Kolíně",
        country: "CZE",
        language: "cs",
        languageGroupKey: "rank-district",
      },
      {
        ...indexed,
        id: groupCsId,
        sourceId,
        caseNumber: "C-1/26 cs",
        citationAuthority: 0,
        court: "Soudní dvůr",
        country: "EU",
        language: "cs",
        languageGroupKey: "rank-group",
      },
      {
        ...indexed,
        id: groupEnId,
        sourceId,
        caseNumber: "C-1/26 en",
        citationAuthority: 4,
        court: "Soudní dvůr",
        country: "EU",
        language: "en",
        languageGroupKey: "rank-group",
      },
    ]);
  },
  { timeout: DB_TEST_TIMEOUT_MS },
);

afterAll(async () => {
  await client.close();
});

test("a fresh supreme decision outranks an equally matching cited district one", async () => {
  const { ranked } = await rank([
    { id: districtId, score: 0.5 },
    { id: supremeId, score: 0.5 },
  ]);

  expect(ranked.map((hit) => hit.id)).toEqual([supremeId, districtId]);
  // The district decision keeps the authority it earned; the tier prior is
  // what the fresh apex decision has instead.
  expect(ranked.at(-1)?.citationAuthority).toBe(0.3);
});

test("a stronger lexical match outranks the higher court", async () => {
  const { ranked } = await rank([
    { id: districtId, score: 0.95 },
    { id: supremeId, score: 0.5 },
  ]);

  expect(ranked.map((hit) => hit.id)).toEqual([districtId, supremeId]);
});

test("the language versions of one judgment are a single hit, ranked by the best", async () => {
  // The Czech version matches the entry better; the English one is the cited
  // record. Blending before the fold is what lets the second stand for both.
  const { ranked } = await rank([
    { id: groupCsId, score: 0.6 },
    { id: groupEnId, score: 0.55 },
  ]);

  expect(ranked.map((hit) => hit.id)).toEqual([groupEnId]);

  const groupOnly = await rank([{ id: groupCsId, score: 0.6 }]);
  expect(groupOnly.ranked.map((hit) => hit.id)).toEqual([groupCsId]);
});

test("ranking one candidate set twice yields the same order", async () => {
  const candidates = [
    { id: districtId, score: 0.5 },
    { id: supremeId, score: 0.5 },
    { id: groupEnId, score: 0.5 },
  ];
  const first = await rank(candidates);
  const again = await rank(candidates.toReversed());

  expect(again.ranked.map((hit) => hit.id)).toEqual(
    first.ranked.map((hit) => hit.id),
  );
});
