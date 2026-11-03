import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { publicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import {
  CORPUS_SCHEMA_LANE_RETRY_MS,
  CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL,
} from "@/api/db/corpus-schema-lane";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { courtWeightMapFromSeed } from "@/api/handlers/case-law/court-weight-seed";
import { listDecisionsHandler } from "@/api/handlers/case-law/decisions/list";
import {
  listSitemapShardDecisionsHandler,
  sitemapShardDecisionsQuerySchema,
} from "@/api/handlers/case-law/decisions/sitemap";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import {
  ACCOUNT_ACCESS,
  createSafeBoundedPublicHandler,
  safePublicHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CASE_LAW_PUBLIC_READ_LANE_WAIT_MS,
  CORPUS_MAINTENANCE_CODE,
} from "@/api/lib/case-law-public-read-db";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { serveForTest } from "@/api/tests/helpers/test-server";
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
  expect(response.items).toHaveLength(1);
  for (const item of response.items) {
    expect(item.languageAlternates.length).toBe(
      LIMITS.caseLawLanguageAlternatesPerGroupMax,
    );
  }
});

/**
 * The public reader while a schema upgrade holds the corpus schema lane:
 * every lane try is refused, and every statement each transaction sends is
 * recorded.
 */
const laneHeldReader = () => {
  const transactions: string[][] = [];
  const reader = async <T>(
    read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
  ) =>
    await caseLawDb(async (tx) => {
      const sent: string[] = [];
      transactions.push(sent);
      return await read(
        new Proxy(tx, {
          get: (target, property, receiver) => {
            if (property === "execute") {
              return async (query: Parameters<typeof target.execute>[0]) => {
                sent.push(typeof query === "string" ? query : "execute");
                return query === CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL
                  ? [{ granted: false }]
                  : await target.execute(query);
              };
            }
            if (property === "select") {
              sent.push("select");
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return value;
          },
        }),
      );
    });
  // SAFETY: brand-only wrapper around the recording read transaction.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test database carries the production read boundary
  return { db: reader as unknown as CaseLawPublicReadDb, transactions };
};

const CZE_SHARD = { bucket: "all", country: "cze", month: "03", year: "2020" };

test("a shard read the schema lane refuses ends each try's transaction and answers unavailable instead of waiting", async () => {
  const held = laneHeldReader();
  const sleeps: number[] = [];
  const rejection: unknown = await listSitemapShardDecisionsHandler(
    CZE_SHARD,
    held.db,
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(rejection).toBeInstanceOf(HandlerError);
  expect(rejection).toMatchObject({
    status: 503,
    code: CORPUS_MAINTENANCE_CODE,
    retryable: true,
  });
  // Each try was its own transaction, which sent the try and nothing else.
  expect(held.transactions.length).toBeGreaterThan(1);
  for (const sent of held.transactions) {
    expect(sent).toEqual([CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL]);
  }
  // It paused between tries, outside any transaction, within its short budget.
  expect(sleeps).toHaveLength(held.transactions.length - 1);
  expect(sleeps.every((ms) => ms <= CORPUS_SCHEMA_LANE_RETRY_MS)).toBe(true);
  expect(sleeps.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(
    CASE_LAW_PUBLIC_READ_LANE_WAIT_MS,
  );
});

test("a shard read refused by the schema lane answers 503 with Retry-After", async () => {
  const held = laneHeldReader();
  // The route's composition: the handler under the bounded public factory.
  const shard = createSafeBoundedPublicHandler(
    {
      contract: "patch",
      accountAccess: ACCOUNT_ACCESS.sandbox,
      mcp: { type: "internal", reason: "public_indexing" },
      cache: { kind: "none" },
      response: safePublicHandlerResponseSchemasWithStatusText(
        v.object({ ok: v.boolean() }),
      ),
      query: sitemapShardDecisionsQuerySchema,
    },
    async function* ({ query }) {
      yield* Result.await(
        Result.tryPromise(
          async () =>
            await listSitemapShardDecisionsHandler(query, held.db, {
              sleep: async () => {},
            }),
        ),
      );
      return Result.ok({ ok: true });
    },
  );
  await using server = serveForTest(
    createHttpApp({
      middleware: [],
      routes: routes({ "/shard": { GET: shard } }),
    }),
  );
  const response = await server.fetch(
    `http://localhost/shard?${new URLSearchParams(CZE_SHARD).toString()}`,
  );
  expect(response.status).toBe(503);
  expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  expect(await response.json()).toMatchObject({
    code: CORPUS_MAINTENANCE_CODE,
    retryable: true,
  });
});
