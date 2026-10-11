// @api-test-heavy-db: retains a full-size 20,000-entry sanctions corpus.
import { Result, panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  parseOfacList,
  readOfacListVersion,
  type ListVersion,
  type ParsedList,
  type SanctionsEntry,
} from "@stll/sanctions";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { createSafeId } from "@/api/lib/branded-types";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { refreshSanctionsSource } from "@/api/lib/lists/sanctions/refresh";
import {
  createSanctionsIndexCache,
  type SanctionsActiveEdition,
} from "@/api/lib/lists/sanctions/screening-index";
import {
  fetchSanctionsEdition,
  type FetchedMarker,
} from "@/api/lib/lists/sanctions/source-fetch";
import { largeOfacSdnXml } from "@/api/lib/lists/sanctions/test-fixtures/large-ofac-list";
import type { safeOutboundFetchStream } from "@/api/lib/safe-outbound-fetch";
import {
  expectEventLoopResponsive,
  pgliteAsOutOfProcess,
  startEventLoopLagProbe,
} from "@/api/tests/helpers/event-loop-lag-probe";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TEST_TIMEOUT_MS = 300_000;
// About the size of the US SDN list.
const ENTRY_COUNT = 20_000;
const LOOP_BUDGET_MS = 100;
const DOWNLOAD_CHUNK_BYTES = 64 * 1024;
const DOWNLOAD_URL = "https://lists.example.test/sdn.xml";
const permit = grantThirdPartyOutboundPermit();
const bytes = new TextEncoder().encode(largeOfacSdnXml(ENTRY_COUNT));

let client: Awaited<ReturnType<typeof createTestPglite>>;
let scopedDb: ScopedDb;
let fixtureVersion: ListVersion;

beforeAll(async () => {
  client = await createTestPglite();
  // PGlite's query CPU is excluded from the event-loop measurement.
  const db = drizzle({ client: pgliteAsOutOfProcess(client) });
  scopedDb = async (fn) =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      return await fn(asTestRaw<Transaction>(tx));
    });
  const version = await readOfacListVersion(
    "us-sdn",
    (async function* () {
      yield bytes;
    })(),
  );
  fixtureVersion = version.unwrap(
    "The synthetic list has no readable edition stamp",
  );
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

const markerFor = (version: ListVersion): FetchedMarker => ({
  source: "us-sdn",
  version,
  downloadUrl: DOWNLOAD_URL,
  lastModified: null,
});

/** A later edition than the fixture's, so a refresh does not stop as unchanged. */
const laterVersion = (): ListVersion => ({
  ...fixtureVersion,
  publishedAt: "2026-09-24",
});

/**
 * Serves the export from memory, one 64 KB chunk per read and every chunk
 * already received: the case where a parse loop over the body would never
 * give timers or I/O a turn. `reads` counts the chunks the parse consumed.
 */
const bufferedStream = (
  onRequest: () => void = () => {},
): {
  fetchStreamRequest: typeof safeOutboundFetchStream;
  reads: () => number;
} => {
  let reads = 0;
  return {
    fetchStreamRequest: async () => {
      onRequest();
      let offset = 0;
      return Result.ok({
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset >= bytes.byteLength) {
              controller.close();
              return;
            }
            reads += 1;
            controller.enqueue(
              bytes.subarray(offset, offset + DOWNLOAD_CHUNK_BYTES),
            );
            offset += DOWNLOAD_CHUNK_BYTES;
          },
        }),
        headers: new Headers(),
        ok: true,
        status: 200,
      });
    },
    reads: () => reads,
  };
};

const activeEdition = async (): Promise<SanctionsActiveEdition> =>
  (await readSanctionsFreshness({ db: scopedDb })).find(
    (item) => item.source === "us-sdn",
  )?.edition ?? panic("No active edition");

test(
  "refreshing and indexing a full-size list never blocks the event loop",
  async () => {
    const indexCache = createSanctionsIndexCache();
    // This process already screens against the source's previous edition, so
    // the refresh rebuilds its index ahead of the next check.
    const warm = await indexCache.get({
      db: scopedDb,
      source: "us-sdn",
      edition: {
        id: createSafeId<"sanctionsEdition">(),
        publishedAt: "2026-09-01",
        fileId: DOWNLOAD_URL,
        entryCount: 0,
      },
    });
    expect(warm.isOk()).toBe(true);

    const probe = startEventLoopLagProbe();
    const outcome = await refreshSanctionsSource({
      permit,
      db: scopedDb,
      source: "us-sdn",
      signal: new AbortController().signal,
      fetchMarker: async () => Result.ok(markerFor(fixtureVersion)),
      fetchEdition: async (requested, options) =>
        await fetchSanctionsEdition(requested, {
          ...options,
          fetchStreamRequest: bufferedStream().fetchStreamRequest,
        }),
    });
    const edition = await activeEdition();
    await indexCache.refresh({ db: scopedDb, source: "us-sdn", edition });
    const report = await probe.stop();

    expect(outcome).toEqual({
      status: "activated",
      source: "us-sdn",
      entryCount: ENTRY_COUNT,
    });
    // The next screening answers from the index the refresh built.
    let reads = 0;
    const index = await indexCache.get({
      db: async (fn) => {
        reads += 1;
        return await scopedDb(fn);
      },
      source: "us-sdn",
      edition,
    });
    expect(reads).toBe(0);
    const built = index.unwrap("The refreshed index was not built");
    expect(built.entries).toHaveLength(ENTRY_COUNT);
    expect(built.identifierEntries.get("P101234")).toBeDefined();
    expectEventLoopResponsive(report, { budgetMs: LOOP_BUDGET_MS });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a cold index load of a full-size list never blocks the event loop",
  async () => {
    // An empty cache builds the index on its first check; PGlite CPU is excluded.
    const edition = await activeEdition();
    const indexCache = createSanctionsIndexCache();
    const probe = startEventLoopLagProbe();
    const index = await indexCache.get({
      db: scopedDb,
      source: "us-sdn",
      edition,
    });
    const report = await probe.stop();

    expect(index.unwrap("The cold index was not built").entries).toHaveLength(
      ENTRY_COUNT,
    );
    expectEventLoopResponsive(report, { budgetMs: LOOP_BUDGET_MS });
  },
  TEST_TIMEOUT_MS,
);

test(
  "a refresh cancelled mid-parse stops reading the received body",
  async () => {
    const before = await activeEdition();
    const controller = new AbortController();
    // Cancel as soon as the parse first gives way.
    const stream = bufferedStream(() => {
      setImmediate(() => {
        controller.abort();
      });
    });
    const outcome = await refreshSanctionsSource({
      permit,
      db: scopedDb,
      source: "us-sdn",
      signal: controller.signal,
      fetchMarker: async () => Result.ok(markerFor(laterVersion())),
      fetchEdition: async (requested, options) =>
        await fetchSanctionsEdition(requested, {
          ...options,
          fetchStreamRequest: stream.fetchStreamRequest,
        }),
    });

    expect(outcome).toEqual({ status: "aborted", source: "us-sdn" });
    const totalChunks = Math.ceil(bytes.byteLength / DOWNLOAD_CHUNK_BYTES);
    expect(stream.reads()).toBeGreaterThan(0);
    expect(stream.reads()).toBeLessThan(totalChunks / 2);
    expect((await activeEdition()).id).toBe(before.id);
  },
  TEST_TIMEOUT_MS,
);

test(
  "a refresh cancelled mid-hash stops before hashing the rest",
  async () => {
    const before = await activeEdition();
    const parsed = (
      await parseOfacList(
        "us-sdn",
        (async function* () {
          yield bytes;
        })(),
      )
    ).unwrap("The synthetic list does not parse");
    const controller = new AbortController();
    const lastEntryRead = { value: false };
    // Hashing is the first pass that reads an entry's legal basis.
    const watched = (
      entry: SanctionsEntry,
      onRead: () => void,
    ): SanctionsEntry => {
      const { legalBasis, ...rest } = entry;
      return {
        ...rest,
        get legalBasis() {
          onRead();
          return legalBasis;
        },
      };
    };
    const entries = parsed.entries.map((entry, index) => {
      if (index === ENTRY_COUNT / 2) {
        return watched(entry, () => {
          controller.abort();
        });
      }
      if (index === ENTRY_COUNT - 1) {
        return watched(entry, () => {
          lastEntryRead.value = true;
        });
      }
      return entry;
    });
    const later: ParsedList = { version: laterVersion(), entries };

    const outcome = await refreshSanctionsSource({
      permit,
      db: scopedDb,
      source: "us-sdn",
      signal: controller.signal,
      fetchMarker: async () => Result.ok(markerFor(later.version)),
      fetchEdition: async () =>
        Result.ok({
          parsed: later,
          contentHash: "b".repeat(64),
          lastModified: null,
        }),
    });

    expect(outcome).toEqual({ status: "aborted", source: "us-sdn" });
    expect(controller.signal.aborted).toBe(true);
    expect(lastEntryRead.value).toBe(false);
    expect((await activeEdition()).id).toBe(before.id);
  },
  TEST_TIMEOUT_MS,
);
