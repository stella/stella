import { Result, panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { buildScreeningIndex, readOfacListVersion } from "@stll/sanctions";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import { createSafeId } from "@/api/lib/branded-types";
import { readSanctionsFreshness } from "@/api/lib/lists/sanctions/freshness";
import { refreshSanctionsSource } from "@/api/lib/lists/sanctions/refresh";
import { createSanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
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
const permit = grantThirdPartyOutboundPermit();

let client: Awaited<ReturnType<typeof createTestPglite>>;
let scopedDb: ScopedDb;

beforeAll(async () => {
  client = await createTestPglite();
  // In production the database is another process; PGlite's own execution
  // time is not the refresh's.
  const db = drizzle({ client: pgliteAsOutOfProcess(client) });
  scopedDb = async (fn) =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      return await fn(asTestRaw<Transaction>(tx));
    });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  await client.close();
});

/**
 * Serves the whole export from memory, already received: every chunk is
 * available at once, the case where a parse loop over the body would never
 * give timers or I/O a turn.
 */
const bufferedStream =
  (bytes: Uint8Array): typeof safeOutboundFetchStream =>
  async () =>
    Result.ok({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (
            let offset = 0;
            offset < bytes.byteLength;
            offset += DOWNLOAD_CHUNK_BYTES
          ) {
            controller.enqueue(
              bytes.subarray(offset, offset + DOWNLOAD_CHUNK_BYTES),
            );
          }
          controller.close();
        },
      }),
      headers: new Headers(),
      ok: true,
      status: 200,
    });

test(
  "refreshing and indexing a full-size list never blocks the event loop",
  async () => {
    const bytes = new TextEncoder().encode(largeOfacSdnXml(ENTRY_COUNT));
    const version = await readOfacListVersion(
      "us-sdn",
      (async function* () {
        yield bytes;
      })(),
    );
    if (version.isErr()) {
      return panic("The synthetic list has no readable edition stamp");
    }
    const marker: FetchedMarker = {
      source: "us-sdn",
      version: version.value,
      downloadUrl: "https://lists.example.test/sdn.xml",
      lastModified: null,
    };
    let screeningBuilds = 0;
    const indexCache = createSanctionsIndexCache({
      build: (lists) => {
        screeningBuilds += 1;
        return buildScreeningIndex(lists);
      },
    });
    // This process already screens against the source's previous edition, so
    // the refresh rebuilds its index ahead of the next check.
    const warm = await indexCache.get({
      db: scopedDb,
      source: "us-sdn",
      edition: {
        id: createSafeId<"sanctionsEdition">(),
        publishedAt: "2026-09-01",
        fileId: marker.downloadUrl,
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
      fetchMarker: async () => Result.ok(marker),
      fetchEdition: async (requested, options) =>
        await fetchSanctionsEdition(requested, {
          ...options,
          fetchStreamRequest: bufferedStream(bytes),
        }),
    });
    const freshness = await readSanctionsFreshness({ db: scopedDb });
    const edition =
      freshness.find((item) => item.source === "us-sdn")?.edition ??
      panic("The refreshed edition is not active");
    await indexCache.refresh({ db: scopedDb, source: "us-sdn", edition });
    const report = await probe.stop();

    expect(outcome).toEqual({
      status: "activated",
      source: "us-sdn",
      entryCount: ENTRY_COUNT,
    });
    // The next screening answers from the index the refresh built.
    const buildsBefore = screeningBuilds;
    const index = await indexCache.get({
      db: scopedDb,
      source: "us-sdn",
      edition,
    });
    expect(screeningBuilds).toBe(buildsBefore);
    if (index.isErr()) {
      return panic("The refreshed index was not built");
    }
    expect(index.value.entries).toHaveLength(ENTRY_COUNT);
    expect(index.value.identifierEntries.has("P101234")).toBe(true);
    expectEventLoopResponsive(report, { budgetMs: LOOP_BUDGET_MS });
  },
  TEST_TIMEOUT_MS,
);
