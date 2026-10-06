import { Result, panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";
import type { ParsedList } from "@stll/sanctions";
import { sha256Hex as hashSha256Hex } from "@stll/sha256/bun";
import { stableStringify } from "@stll/stable-stringify";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  sanctionsEditions,
  sanctionsEditionEntries,
  sanctionsEntryPayloads,
  sanctionsSources,
} from "@/api/db/schema";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import {
  refreshSanctionsSource,
  SANCTIONS_PARSER_VERSION,
} from "@/api/lib/lists/sanctions/refresh";
import { SanctionsRefreshError } from "@/api/lib/lists/sanctions/source-fetch";
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
    issuer: "CZ",
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
    lastModified: null,
  });

const markerKey = (
  parsed: ParsedList,
  parserVersion = SANCTIONS_PARSER_VERSION,
) => hashSha256Hex(stableStringify({ parserVersion, version: parsed.version }));

test(
  "activates a complete edition and verifies the same marker without re-downloading",
  async () => {
    const parsed = list("2026-07-23");
    let downloads = 0;
    const fetchEdition = async () => {
      downloads += 1;
      return Result.ok({
        parsed,
        contentHash: CONTENT_HASH,
        lastModified: null,
      });
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
    const memberships = await db.select().from(sanctionsEditionEntries);
    const payloads = await db.select().from(sanctionsEntryPayloads);
    expect(memberships).toHaveLength(1);
    expect(payloads).toHaveLength(1);
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
        Result.ok({ parsed, contentHash: "b".repeat(64), lastModified: null }),
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
    expect(cz?.status).toBe("fresh");
    expect(cz?.heldUpdate?.code).toBe("contracted");
    expect(cz?.annotation).toEqual({
      type: "held-for-review",
      code: "contracted",
    });
    const stale = await readSanctionsFreshness({
      db: scopedDb,
      now: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
    });
    expect(stale.find((item) => item.source === "cz")?.reason).toBe("stale");
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

    expect(
      await rejectionOf(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella`);
          await tx.insert(sanctionsSources).values({
            id: "request-write",
            issuer: "Test",
            markerUrl: SOURCE_URL,
          });
        }),
      ),
    ).toMatchObject({
      cause: { code: "42501" },
    });
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "re-reads a changed marker once and reuses identical entry payloads",
  async () => {
    const oldMarker = list("2026-07-25");
    const currentList = list("2026-07-26");
    let markerReads = 0;
    let downloads = 0;
    const outcome = await refreshSanctionsSource({
      db: scopedDb,
      source: "cz",
      signal: new AbortController().signal,
      fetchMarker: async () => {
        markerReads += 1;
        const version =
          markerReads === 1 ? oldMarker.version : currentList.version;
        return Result.ok({
          source: "cz" as const,
          version,
          downloadUrl: SOURCE_URL,
          lastModified: null,
        });
      },
      fetchEdition: async () => {
        downloads += 1;
        return Result.ok({
          parsed: currentList,
          contentHash: "c".repeat(64),
          lastModified: null,
        });
      },
    });
    expect(outcome).toEqual({
      status: "activated",
      source: "cz",
      entryCount: 1,
    });
    expect(markerReads).toBe(2);
    expect(downloads).toBe(2);
    expect(await db.select().from(sanctionsEditionEntries)).toHaveLength(2);
    expect(await db.select().from(sanctionsEntryPayloads)).toHaveLength(1);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "a parser-version change supersedes an unfinished stage without mixing its entries",
  async () => {
    const parsed = list("2026-07-27");
    const contentHash = "d".repeat(64);
    const [oldStage] = await db
      .insert(sanctionsEditions)
      .values({
        sourceId: "cz",
        markerKey: markerKey(parsed, `${SANCTIONS_PARSER_VERSION}-old`),
        publishedAt: parsed.version.publishedAt,
        fileId: parsed.version.fileId,
        contentHash,
        entryCount: 1,
        state: "staging",
      })
      .returning({ id: sanctionsEditions.id });
    const outcome = await refreshSanctionsSource({
      db: scopedDb,
      source: "cz",
      signal: new AbortController().signal,
      fetchMarker: markerFor(parsed),
      fetchEdition: async () =>
        Result.ok({ parsed, contentHash, lastModified: null }),
    });
    expect(outcome).toEqual({
      status: "activated",
      source: "cz",
      entryCount: 1,
    });
    const editions = await db
      .select()
      .from(sanctionsEditions)
      .where(eq(sanctionsEditions.contentHash, contentHash));
    expect(editions).toHaveLength(2);
    expect(
      editions.find((edition) => edition.id === oldStage?.id)?.guardCode,
    ).toBe("superseded");
    expect(
      editions.find((edition) => edition.markerKey === markerKey(parsed))
        ?.state,
    ).toBe("ready");
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "an inconsistent stage is rejected and leaves the last active edition intact",
  async () => {
    const parsed = list("2026-07-28");
    const contentHash = "e".repeat(64);
    const [activeBefore] = await db
      .select({ id: sanctionsSources.activeEditionId })
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, "cz"));
    const [payload] = await db
      .select({ contentHash: sanctionsEntryPayloads.contentHash })
      .from(sanctionsEntryPayloads)
      .limit(1);
    const [stage] = await db
      .insert(sanctionsEditions)
      .values({
        sourceId: "cz",
        markerKey: markerKey(parsed),
        publishedAt: parsed.version.publishedAt,
        fileId: parsed.version.fileId,
        contentHash,
        entryCount: 1,
        state: "staging",
      })
      .returning({ id: sanctionsEditions.id });
    if (!stage || !payload) {
      panic("Missing sanctions test fixture");
    }
    await db.insert(sanctionsEditionEntries).values({
      editionId: stage.id,
      sourceEntryId: "unexpected",
      contentHash: payload.contentHash,
    });
    const options = {
      db: scopedDb,
      source: "cz" as const,
      signal: new AbortController().signal,
      fetchMarker: markerFor(parsed),
      fetchEdition: async () =>
        Result.ok({ parsed, contentHash, lastModified: null }),
    };
    expect(await refreshSanctionsSource(options)).toEqual({
      status: "failed",
      source: "cz",
      code: "parse-failed",
    });
    expect(await refreshSanctionsSource(options)).toEqual({
      status: "failed",
      source: "cz",
      code: "parse-failed",
    });
    const [after] = await db
      .select()
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, "cz"));
    const [rejected] = await db
      .select()
      .from(sanctionsEditions)
      .where(eq(sanctionsEditions.id, stage.id));
    expect(after?.activeEditionId).toBe(activeBefore?.id);
    expect(rejected?.state).toBe("rejected");
    expect(rejected?.guardCode).toBe("invalid-stage");
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "holds a publisher rollback to a historical ready edition without rewriting its audit state",
  async () => {
    const parsed = list("2026-07-23");
    const [activeBefore] = await db
      .select({ id: sanctionsSources.activeEditionId })
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, "cz"));
    const [historical] = await db
      .select({ id: sanctionsEditions.id })
      .from(sanctionsEditions)
      .where(eq(sanctionsEditions.markerKey, markerKey(parsed)));
    if (!activeBefore?.id || !historical) {
      panic("Missing historical sanctions edition test fixture");
    }
    const outcome = await refreshSanctionsSource({
      db: scopedDb,
      source: "cz",
      signal: new AbortController().signal,
      fetchMarker: markerFor(parsed),
      fetchEdition: async () =>
        Result.ok({ parsed, contentHash: CONTENT_HASH, lastModified: null }),
    });
    expect(outcome).toEqual({
      status: "held",
      source: "cz",
      code: "replacement-stale",
    });
    const [source] = await db
      .select()
      .from(sanctionsSources)
      .where(eq(sanctionsSources.id, "cz"));
    const [edition] = await db
      .select()
      .from(sanctionsEditions)
      .where(eq(sanctionsEditions.id, historical.id));
    expect(source?.activeEditionId).toBe(activeBefore.id);
    expect(source?.heldEditionId).toBe(historical.id);
    expect(source?.heldGuardCode).toBe("stale");
    expect(edition?.state).toBe("ready");
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "activates a complete edition when database and JavaScript order source ids differently",
  async () => {
    const parsed = list("2026-07-29", 2);
    const [first, second] = parsed.entries;
    if (!first || !second) {
      panic("Missing sanctions test entries");
    }
    first.sourceId = "\uE000";
    second.sourceId = "\u{10000}";
    const outcome = await refreshSanctionsSource({
      db: scopedDb,
      source: "cz",
      signal: new AbortController().signal,
      fetchMarker: markerFor(parsed),
      fetchEdition: async () =>
        Result.ok({ parsed, contentHash: "f".repeat(64), lastModified: null }),
    });
    expect(outcome).toEqual({
      status: "activated",
      source: "cz",
      entryCount: 2,
    });
  },
  DB_TEST_TIMEOUT_MS,
);

type DatedSource = "us-sdn" | "uk";

const datedList = (source: DatedSource, publishedAt: string): ParsedList => ({
  version: { source, publishedAt, fileId: null },
  entries: [
    {
      source,
      issuer: source === "uk" ? "GB" : "US",
      sourceId: "1",
      referenceNumber: null,
      entityType: "person",
      names: [{ name: "Person 1", quality: "strong" }],
      birthDates: [],
      nationalities: [],
      identifiers: [],
      addresses: [],
      programme: null,
      legalBasis: null,
      listedOn: null,
      sourceUrl: SOURCE_URL,
    },
  ],
});

/** Seeds an active edition keyed as it was before validators joined the key. */
const seedActiveEdition = async (parsed: ParsedList): Promise<void> => {
  const source = parsed.version.source;
  await db
    .insert(sanctionsSources)
    .values({ id: source, issuer: "Test", markerUrl: SOURCE_URL });
  const [edition] = await db
    .insert(sanctionsEditions)
    .values({
      sourceId: source,
      markerKey: markerKey(parsed),
      publishedAt: parsed.version.publishedAt,
      fileId: parsed.version.fileId,
      contentHash: "0".repeat(64),
      entryCount: parsed.entries.length,
      state: "ready",
      activatedAt: new Date(),
    })
    .returning({ id: sanctionsEditions.id });
  if (!edition) {
    panic("Missing seeded sanctions edition");
  }
  await db
    .update(sanctionsSources)
    .set({ activeEditionId: edition.id })
    .where(eq(sanctionsSources.id, source));
};

/**
 * Serves one dated list. Each marker read and each download answers with the
 * next Last-Modified of its sequence, repeating the last one.
 */
const datedRefresh = (
  source: DatedSource,
  parsed: ParsedList,
  stamps: {
    markers: readonly (string | null)[];
    downloads: readonly (string | null)[];
  },
) => {
  let markerReads = 0;
  let downloads = 0;
  const stampAt = (sequence: readonly (string | null)[], index: number) =>
    sequence[Math.min(index, sequence.length - 1)] ?? null;
  const run = async () =>
    await refreshSanctionsSource({
      db: scopedDb,
      source,
      signal: new AbortController().signal,
      fetchMarker: async () => {
        const lastModified = stampAt(stamps.markers, markerReads);
        markerReads += 1;
        return Result.ok({
          source,
          version: parsed.version,
          downloadUrl: SOURCE_URL,
          lastModified,
        });
      },
      fetchEdition: async () => {
        const lastModified = stampAt(stamps.downloads, downloads);
        downloads += 1;
        return Result.ok({
          parsed,
          contentHash: hashSha256Hex(lastModified ?? "none"),
          lastModified,
        });
      },
    });
  return { run, counts: () => ({ markerReads, downloads }) };
};

const sameStamp = (stamp: string | null) => ({
  markers: [stamp],
  downloads: [stamp],
});

test(
  "a same-day OFAC republication with a new Last-Modified is a new edition",
  async () => {
    const parsed = datedList("us-sdn", "2026-09-23");
    await seedActiveEdition(parsed);

    const first = datedRefresh(
      "us-sdn",
      parsed,
      sameStamp("2026-09-23T08:00:00Z"),
    );
    expect(await first.run()).toEqual({
      status: "activated",
      source: "us-sdn",
      entryCount: 1,
    });
    expect(first.counts().downloads).toBe(1);

    const same = datedRefresh(
      "us-sdn",
      parsed,
      sameStamp("2026-09-23T08:00:00Z"),
    );
    expect(await same.run()).toEqual({ status: "unchanged", source: "us-sdn" });
    expect(same.counts().downloads).toBe(0);

    const republished = datedRefresh(
      "us-sdn",
      parsed,
      sameStamp("2026-09-23T17:30:00Z"),
    );
    expect(await republished.run()).toEqual({
      status: "activated",
      source: "us-sdn",
      entryCount: 1,
    });
    expect(republished.counts().downloads).toBe(1);

    const editions = await db
      .select()
      .from(sanctionsEditions)
      .where(eq(sanctionsEditions.sourceId, "us-sdn"));
    expect(editions).toHaveLength(3);
    expect(
      editions.every((edition) => edition.publishedAt === "2026-09-23"),
    ).toBe(true);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "without Last-Modified a same-day edition is keyed by its stated date alone",
  async () => {
    const parsed = datedList("uk", "2026-09-21");
    await seedActiveEdition(parsed);

    const refresh = datedRefresh("uk", parsed, sameStamp(null));
    expect(await refresh.run()).toEqual({ status: "unchanged", source: "uk" });
    expect(refresh.counts().downloads).toBe(0);
  },
  DB_TEST_TIMEOUT_MS,
);

test(
  "re-reads the marker when the download carries a newer Last-Modified",
  async () => {
    const parsed = datedList("uk", "2026-09-22");
    const raced = datedRefresh("uk", parsed, {
      markers: ["2026-09-22T08:00:00Z", "2026-09-22T09:00:00Z"],
      downloads: ["2026-09-22T09:00:00Z"],
    });
    expect(await raced.run()).toEqual({
      status: "activated",
      source: "uk",
      entryCount: 1,
    });
    expect(raced.counts()).toEqual({ markerReads: 2, downloads: 2 });

    const settled = datedRefresh(
      "uk",
      parsed,
      sameStamp("2026-09-22T09:00:00Z"),
    );
    expect(await settled.run()).toEqual({ status: "unchanged", source: "uk" });
    expect(settled.counts().downloads).toBe(0);
  },
  DB_TEST_TIMEOUT_MS,
);
