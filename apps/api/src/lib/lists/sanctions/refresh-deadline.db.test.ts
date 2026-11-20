import { Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ParsedList, SanctionsSource } from "@stll/sanctions";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { sanctionsSources } from "@/api/db/schema";
import { grantThirdPartyOutboundPermit } from "@/api/lib/auth/third-party-outbound-permit";
import {
  refreshSanctionsSource,
  SANCTIONS_FETCH_DEADLINE_MS,
} from "@/api/lib/lists/sanctions/refresh";
import { sanctionsSourceIds } from "@/api/lib/lists/sanctions/source-config";
import { SanctionsRefreshError } from "@/api/lib/lists/sanctions/source-fetch";
import { SCHEDULER_MAX_RUNTIME_MS } from "@/api/lib/scheduler/run-limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SOURCE_URL =
  "https://mzv.gov.cz/file/1/Vnitrostatni_sankcni_seznam_2026_07_23.csv";
const permit = grantThirdPartyOutboundPermit();

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
});

afterAll(async () => {
  await client.close();
});

const czList: ParsedList = {
  version: { source: "cz", publishedAt: "2026-07-23", fileId: SOURCE_URL },
  entries: [
    {
      source: "cz",
      issuer: "CZ",
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
};

/**
 * A publisher request that never delivers. It ends only when its signal is
 * aborted, then fails as the outbound transport does, and records why.
 */
const stalledPublisher = (source: SanctionsSource) => {
  const reasons: unknown[] = [];
  const stall = async (options: { signal: AbortSignal }) => {
    if (!options.signal.aborted) {
      await new Promise((resolve) => {
        options.signal.addEventListener("abort", resolve, { once: true });
      });
    }
    reasons.push(options.signal.reason);
    return Result.err(
      new SanctionsRefreshError({
        source,
        code: "fetch-failed",
        message: "request aborted",
      }),
    );
  };
  return { stall, reasons: () => [...reasons] };
};

const sourceRow = async (source: SanctionsSource) => {
  const [row] = await db
    .select()
    .from(sanctionsSources)
    .where(eq(sanctionsSources.id, source));
  return row;
};

test("a stalled publisher ends at its fetch deadline as a recorded failure and the next source still refreshes", async () => {
  const run = new AbortController();
  const publisher = stalledPublisher("eu");
  const stalled = await refreshSanctionsSource({
    permit,
    db: scopedDb,
    source: "eu",
    signal: run.signal,
    fetchDeadlineMs: 50,
    fetchMarker: async (_source, options) => await publisher.stall(options),
  });
  expect(stalled).toEqual({
    status: "failed",
    source: "eu",
    code: "fetch-failed",
  });
  expect(publisher.reasons()).toHaveLength(1);
  expect(publisher.reasons()[0]).toMatchObject({ name: "TimeoutError" });
  expect(run.signal.aborted).toBe(false);
  expect(await sourceRow("eu")).toMatchObject({
    activeEditionId: null,
    lastFailureCode: "fetch-failed",
  });

  const next = await refreshSanctionsSource({
    permit,
    db: scopedDb,
    source: "cz",
    signal: run.signal,
    fetchDeadlineMs: 50,
    fetchMarker: async () =>
      Result.ok({
        source: "cz" as const,
        version: czList.version,
        downloadUrl: SOURCE_URL,
        lastModified: null,
      }),
    fetchEdition: async () =>
      Result.ok({
        parsed: czList,
        contentHash: "a".repeat(64),
        lastModified: null,
      }),
  });
  expect(next).toEqual({ status: "activated", source: "cz", entryCount: 1 });
});

test("a download that stalls after its marker is bounded by the same deadline", async () => {
  const publisher = stalledPublisher("un");
  let markerReads = 0;
  const outcome = await refreshSanctionsSource({
    permit,
    db: scopedDb,
    source: "un",
    signal: new AbortController().signal,
    fetchDeadlineMs: 50,
    fetchMarker: async () => {
      markerReads += 1;
      return Result.ok({
        source: "un" as const,
        version: { source: "un", publishedAt: "2026-07-23", fileId: null },
        downloadUrl:
          "https://scsanctions.un.org/resources/xml/en/consolidated.xml",
        lastModified: null,
      });
    },
    fetchEdition: async (_marker, options) => await publisher.stall(options),
  });
  expect(outcome).toEqual({
    status: "failed",
    source: "un",
    code: "fetch-failed",
  });
  expect(markerReads).toBe(1);
  expect(publisher.reasons()[0]).toMatchObject({ name: "TimeoutError" });
  expect((await sourceRow("un"))?.lastFailureCode).toBe("fetch-failed");
});

test("the run's own abort stays an abort and records nothing", async () => {
  const run = new AbortController();
  const publisher = stalledPublisher("uk");
  const outcome = await refreshSanctionsSource({
    permit,
    db: scopedDb,
    source: "uk",
    signal: run.signal,
    fetchMarker: async (_source, options) => {
      run.abort(new Error("scheduler run ceiling"));
      return await publisher.stall(options);
    },
  });
  expect(outcome).toEqual({ status: "aborted", source: "uk" });
  expect(publisher.reasons()).toEqual([new Error("scheduler run ceiling")]);
  expect(await sourceRow("uk")).toMatchObject({
    lastFailureAt: null,
    lastFailureCode: null,
  });
});

test("every source's fetch deadline fits in one scheduler run with room to stage and index", () => {
  expect(
    sanctionsSourceIds().length * SANCTIONS_FETCH_DEADLINE_MS,
  ).toBeLessThanOrEqual((SCHEDULER_MAX_RUNTIME_MS * 3) / 4);
});
