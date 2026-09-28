import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ParsedList } from "@stll/sanctions";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  sanctionsEditions,
  sanctionsEntries,
  sanctionsSources,
} from "@/api/db/schema";
import { readSanctionsFreshness } from "@/api/lib/sanctions/freshness";
import { refreshSanctionsSource } from "@/api/lib/sanctions/refresh";
import { SanctionsRefreshError } from "@/api/lib/sanctions/source-fetch";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const DB_TEST_TIMEOUT_MS = 120_000;
const CONTENT_HASH = "a".repeat(64);
const SOURCE_URL =
  "https://mzv.gov.cz/file/1/Vnitrostatni_sankcni_seznam_2026_07_23.csv";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = async (fn) =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      return await fn(asTestRaw<Transaction>(tx));
    });
}, DB_TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

const list = (publishedAt: string, entries = 1): ParsedList => ({
  version: { source: "cz", publishedAt, fileId: SOURCE_URL },
  entries: Array.from({ length: entries }, (_, index) => ({
    source: "cz",
    sourceId: String(index + 1),
    referenceNumber: null,
    entityType: "person",
    names: [{ name: `Person ${index}`, quality: "strong" }],
    birthDates: [],
    nationalities: [],
    identifiers: [],
    addresses: [],
    programme: null,
    legalBasis: null,
    listedOn: null,
    sourceUrl: SOURCE_URL,
  })),
});

const markerFor = (parsed: ParsedList) => async () =>
  Result.ok({
    source: "cz" as const,
    version: parsed.version,
    downloadUrl: SOURCE_URL,
  });

test(
  "activates a complete edition and verifies the same marker without re-downloading",
  async () => {
    const parsed = list("2026-07-23");
    let downloads = 0;
    const fetchEdition = async () => {
      downloads += 1;
      return Result.ok({ parsed, contentHash: CONTENT_HASH });
    };
    const options = {
      db: scopedDb,
      source: "cz" as const,
      signal: new AbortController().signal,
      fetchMarker: markerFor(parsed),
      fetchEdition,
    };

    expect(await refreshSanctionsSource(options)).toEqual({
      status: "activated",
      source: "cz",
      entryCount: 1,
    });
    expect(await refreshSanctionsSource(options)).toEqual({
      status: "unchanged",
      source: "cz",
    });
    expect(downloads).toBe(1);

    const [source] = await db
      .select()
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, "cz"));
    expect(source?.activeEditionId).not.toBeNull();
    const entries = await db.select().from(sanctionsEntries);
    expect(entries).toHaveLength(1);
    const freshness = await readSanctionsFreshness({ db: scopedDb });
    expect(freshness.find((item) => item.source === "cz")?.status).toBe(
      "fresh",
    );
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "holds an incomplete replacement and preserves the active edition",
  async () => {
    const before = await db
      .select()
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, "cz"));
    const parsed = list("2026-07-24", 0);
    const options = {
      db: scopedDb,
      source: "cz" as const,
      signal: new AbortController().signal,
      fetchMarker: markerFor(parsed),
      fetchEdition: async () =>
        Result.ok({ parsed, contentHash: "b".repeat(64) }),
    };
    const outcome = await refreshSanctionsSource(options);
    expect(outcome).toEqual({
      status: "held",
      source: "cz",
      code: "replacement-contracted",
    });
    const [after] = await db
      .select()
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, "cz"));
    expect(after?.activeEditionId).toBe(before.at(0)?.activeEditionId);
    const rejected = await db
      .select()
      .from(sanctionsEditions)
      .where(eq(sanctionsEditions.state, "rejected"));
    expect(rejected.at(0)?.guardCode).toBe("contracted");
    expect(await refreshSanctionsSource(options)).toEqual(outcome);
    const replayed = await db
      .select()
      .from(sanctionsEditions)
      .where(eq(sanctionsEditions.state, "rejected"));
    expect(replayed).toHaveLength(1);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "reports access denial without replacing the last good edition",
  async () => {
    const outcome = await refreshSanctionsSource({
      db: scopedDb,
      source: "cz",
      signal: new AbortController().signal,
      fetchMarker: async () =>
        Result.err(
          new SanctionsRefreshError({
            source: "cz",
            code: "access-denied",
            message: "Access denied",
          }),
        ),
    });
    expect(outcome).toEqual({
      status: "failed",
      source: "cz",
      code: "access-denied",
    });
    const freshness = await readSanctionsFreshness({ db: scopedDb });
    const cz = freshness.find((item) => item.source === "cz");
    expect(cz?.edition?.entryCount).toBe(1);
    expect(cz?.reason).toBe("access-denied");
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "request role can read editions but cannot write global list state",
  async () => {
    const rows = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella`);
      return await tx
        .select()
        .from(sanctionsSources)
        .where(eq(sanctionsSources.id, "cz"));
    });
    expect(rows.at(0)?.activeEditionId).not.toBeNull();

    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella`);
        await tx.insert(sanctionsSources).values({
          id: "request-write",
          issuer: "Test",
          markerUrl: SOURCE_URL,
        });
      }),
    ).rejects.toMatchObject({
      cause: { code: "42501" },
    });
  },
  DB_TEST_TIMEOUT_MS,
);
