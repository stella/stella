/**
 * A SAOS judgment whose detail read failed, carried through the store and the
 * reconciliation engine: the crawl keeps the dump's text in public and states
 * the failed read on the row, the engine's walk of the judgment's date selects
 * that row although it is held, and a detail read that succeeds restates the
 * row as read and enriched.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCoverageSlices,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import type { SaosItem } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { plCourtsAdapter } from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { requireReconciliation } from "@/api/handlers/case-law/ingestion/adapters/test-utils";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { runReconciliationWorkUnit } from "@/api/handlers/case-law/ingestion/reconciliation-engine";
import { getCaseLawIngestionMetadata } from "@/api/handlers/case-law/metadata";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { addUtcDays, toUtcDateString } from "@/api/lib/dates";
import { partialObservationFromMetadata } from "@/api/lib/legal-search/ingestion-normalization";
import type { SourceReconciliation } from "@/api/lib/legal-search/ingestion-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;
let fake: FakeS3;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the pipeline expects.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  fake.stop();
});

const NOW = new Date();
const day = (offset: number): string =>
  toUtcDateString(addUtcDays(NOW, offset));
/** The judgment date the walk reconciles; also the walk's first slice. */
const SLICE = day(-5);

/** A real SAOS district-court record, carrying its text as the dump does. */
const JUDGMENT = {
  id: 130_600,
  href: "https://www.saos.org.pl/api/judgments/130600",
  courtType: "COMMON",
  courtCases: [{ caseNumber: "II Co 433/15" }],
  judgmentType: "DECISION",
  judgmentDate: SLICE,
  textContent: "<p>Sąd Rejonowy postanawia oddalić wniosek.</p>",
  division: {
    id: 203,
    name: "II Wydział Cywilny Sekcja Egzekucyjna",
    court: { id: 36, code: "15050505", name: "Sąd Rejonowy w Białymstoku" },
  },
} as const satisfies SaosItem;

const RAPPORTEUR = "Anna Nowak";

/** SAOS, with the per-judgment endpoint answering as `detail` says. */
const serveSaos = (detail: () => Response): void => {
  globalThis.fetch = Object.assign(
    async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://www.saos.org.pl/")) {
        return await originalFetch(input, init);
      }
      if (url.includes("/api/dump/judgments")) {
        return Response.json({ items: [JUDGMENT] });
      }
      if (url.includes("/api/search/judgments")) {
        return Response.json({
          items: [JUDGMENT],
          info: { totalResults: 1 },
        });
      }
      if (url.endsWith(`/api/judgments/${JUDGMENT.id}`)) {
        return detail();
      }
      return new Response("Not found", { status: 404 });
    },
    { preconnect: originalFetch.preconnect.bind(originalFetch) },
  );
};

const seedSource = async (): Promise<SafeId<"caseLawSource">> => {
  const id = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id,
    adapterKey: `pl-courts-recheck-${id}`,
    name: "pl-courts recheck fixture",
    config: {},
    // The crawl's write below takes the first observation order.
    observationOrder: 1n,
  });
  return id;
};

/** A fresh tip, and the judgment's date as a stale slice owing one record. */
const seedLedger = async (sourceId: SafeId<"caseLawSource">): Promise<void> => {
  const rows = [
    { slice: day(0), reported: 0, collected: 0, checkedAt: NOW },
    { slice: day(-1), reported: 0, collected: 0, checkedAt: NOW },
    { slice: SLICE, reported: 1, collected: 0, checkedAt: addUtcDays(NOW, -2) },
  ];
  for (const row of rows) {
    await db.insert(caseLawCoverageSlices).values({
      id: createSafeId<"caseLawCoverageSlice">(),
      sourceId,
      ...row,
    });
  }
};

/** The adapter's own reconciliation, over a walk of recent days. */
const reconciliation: SourceReconciliation = {
  ...requireReconciliation(plCourtsAdapter),
  firstSlice: SLICE,
  sliceOf: toUtcDateString,
  nextSlice: (slice) => {
    const next = toUtcDateString(
      addUtcDays(new Date(`${slice}T00:00:00.000Z`), 1),
    );
    return next > day(0) ? null : next;
  },
  previousSlice: (slice) => {
    const previous = toUtcDateString(
      addUtcDays(new Date(`${slice}T00:00:00.000Z`), -1),
    );
    return previous < SLICE ? null : previous;
  },
  tipWindowDays: 2,
};

const storedRow = async (sourceId: SafeId<"caseLawSource">) => {
  const [row] = await db
    .select({
      metadata: caseLawDecisions.metadata,
      fulltext: caseLawDecisions.fulltext,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  if (row === undefined) {
    throw new Error("expected the judgment to be stored");
  }
  return { ...row, metadata: row.metadata ?? {} };
};

test("a judgment whose detail read failed is read again by the reconciliation and settles enriched", async () => {
  const sourceId = await seedSource();

  // The crawl: SAOS fails the detail read, and the dump row is stored.
  serveSaos(() => new Response("upstream failure", { status: 503 }));
  const crawled = (await plCourtsAdapter.fetchPage(null, {})).unwrap()
    .decisions[0];
  if (crawled === undefined) {
    throw new Error("expected the crawl to build the judgment");
  }
  const stored = await processDecision({
    input: crawled,
    sourceId,
    scopedDb,
    observedAt: NOW,
    observationOrder: 1n,
  });
  expect(stored.status).toBe("complete");
  const before = await storedRow(sourceId);
  expect(before.fulltext).toContain("oddalić wniosek");
  expect(partialObservationFromMetadata(before.metadata).isListingOnly).toBe(
    false,
  );
  expect(before.metadata["detailReadState"]).toBe("failed");

  // The walk of the judgment's date: SAOS now answers the detail.
  await seedLedger(sourceId);
  serveSaos(() =>
    Response.json({
      data: { ...JUDGMENT, judges: [{ name: RAPPORTEUR }] },
    }),
  );
  const outcome = await runReconciliationWorkUnit({
    adapterKey: "pl-courts",
    sourceId,
    reconciliation,
    reparseStoredRaw: undefined,
    scopedDb,
    now: () => NOW,
    fetchDelayMs: 0,
    sleep: async () => {
      await Promise.resolve();
    },
    sliceRetries: new Map(),
  });

  // The held row was selected, built from its detail and written.
  expect(outcome).toMatchObject({
    type: "worked",
    summary: { slice: SLICE, keyable: 1, heldBefore: 0, written: 1 },
  });
  const after = await storedRow(sourceId);
  expect(after.metadata["detailReadState"]).toBe("read");
  expect(getCaseLawIngestionMetadata(after.metadata)?.sourceTier).toBe(
    "detail",
  );
  expect(JSON.stringify(after.metadata["judges"])).toContain(RAPPORTEUR);
  expect(after.fulltext).toContain("oddalić wniosek");
});
