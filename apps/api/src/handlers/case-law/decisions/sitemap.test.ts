import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { listDecisionsHandler } from "@/api/handlers/case-law/decisions/list";
import { listSitemapShardDecisionsHandler } from "@/api/handlers/case-law/decisions/sitemap";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { LIMITS } from "@/api/lib/limits";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let caseLawDb: CaseLawPublicReadDb;

const sourceId = createSafeId<"caseLawSource">();

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });
    const readDb = async <T>(
      read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
    ) =>
      await withPublicLawReaderRole(db, async (roleTx) => {
        // SAFETY: the role transaction supplies the select surface the reads use.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test handle stands in for a transaction
        const tx = roleTx as unknown as CaseLawPublicReadTransaction;
        return await read(tx);
      });
    // SAFETY: brand-only wrapper around the read-role transaction helper.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test database carries the production read boundary
    caseLawDb = readDb as unknown as CaseLawPublicReadDb;

    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "test",
      name: "Test source",
    });

    await db.insert(caseLawDecisions).values([
      {
        id: createSafeId<"caseLawDecision">(),
        sourceId,
        caseNumber: "1 Cdo 1/2020",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2020-03-15",
      },
      {
        id: createSafeId<"caseLawDecision">(),
        sourceId,
        caseNumber: "2 Cdo 2/2020",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2020-05-20",
      },
      {
        id: createSafeId<"caseLawDecision">(),
        sourceId,
        caseNumber: "3 Cdo 3/2021",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2021-01-10",
      },
      {
        // A dateless decision exercises the COALESCE undated-year/month fallback,
        // the literal that previously got bound as a parameter.
        id: createSafeId<"caseLawDecision">(),
        sourceId,
        caseNumber: "4 Cdo 4/undated",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        decisionDate: null,
      },
      {
        id: createSafeId<"caseLawDecision">(),
        sourceId,
        caseNumber: "synthetic-hidden",
        court: "Synthetic Court",
        country: "XAA",
        language: "xx",
        decisionDate: "2020-03-15",
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

test("sitemap shards reject countries outside the public list", async () => {
  const unavailable = await listSitemapShardDecisionsHandler(
    { bucket: "all", country: "xaa", month: "03", year: "2020" },
    caseLawDb,
  );
  if (!("code" in unavailable)) {
    panic("Expected an unavailable-country response.");
  }
  expect(unavailable.code).toBe(404);
});

test("the public list read stays inside the country boundary", async () => {
  const country =
    publicCaseLawCountry("CZE") ?? panic("Expected a public test country.");
  const listed = await listDecisionsHandler(
    { country, limit: 10 },
    caseLawDb,
    // The registry as the seed migration writes it: this harness holds the
    // public reader alone, and the loader reads the root pool.
    async () => courtWeightMapFromSeed(),
  );
  expect("items" in listed).toBe(true);
  if ("items" in listed) {
    expect(listed.items).toHaveLength(4);
    expect(listed.items.every((item) => item.country === country)).toBe(true);
  }
});

test("sitemap bounds every language group even within a larger batch", async () => {
  const languageGroupKey = "sitemap-overflow-group";
  const variants = Array.from(
    { length: LIMITS.caseLawLanguageAlternatesPerGroupMax + 1 },
    (_, index) => ({
      id: createSafeId<"caseLawDecision">(),
      sourceId,
      caseNumber: "sitemap-overflow",
      court: "Nejvyšší soud",
      country: "CZE",
      language: `q${String.fromCodePoint(97 + Math.floor(index / 26))}${String.fromCodePoint(97 + (index % 26))}`,
      languageGroupKey,
      decisionDate: "2020-06-01",
    }),
  );
  await db.insert(caseLawDecisions).values(variants);
  const response = await listSitemapShardDecisionsHandler(
    { country: "cze", year: "2020", month: "06", bucket: "all" },
    caseLawDb,
  );
  if (!("items" in response)) {
    panic("Sitemap overflow fixture failed to load");
  }
  expect(response.items.length).toBe(variants.length);
  for (const item of response.items) {
    expect(item.languageAlternates.length).toBe(
      LIMITS.caseLawLanguageAlternatesPerGroupMax,
    );
  }
});
