import { Result } from "better-result";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ScopedDb } from "@/api/db/safe-db";
import { legislationDocuments, legislationSources } from "@/api/db/schema";
import {
  processLegislationDocument,
  runLegislationIngestion,
} from "@/api/handlers/legislation/ingestion";
import type { ProcessLegislationResult } from "@/api/handlers/legislation/ingestion";
import { createSafeId } from "@/api/lib/branded-types";
import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";
import type {
  LegislationDocumentInput,
  LegislationSourceAdapter,
  LegislationSyncPage,
} from "@/api/lib/legal-search/legislation-ingestion-types";
import type { WriteRawSourcePayload } from "@/api/lib/legal-search/raw-source-storage";
import { logger } from "@/api/lib/observability/logger";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// Validates the legislation ingestion entry: store + upsert + source-hash
// dedup, the payload round trip, and the runner's URL boundary. The
// corpus storage mode is "off" in tests, so no S3 is touched; the raw-payload
// write is injected.

let client: Awaited<ReturnType<typeof createTestPglite>> | undefined;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const sourceId = createSafeId<"legislationSource">();
const runnerSourceId = createSafeId<"legislationSource">();
const heldCursorSourceId = createSafeId<"legislationSource">();
const coverageSourceId = createSafeId<"legislationSource">();

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(legislationSources).values([
      {
        id: sourceId,
        adapterKey: "test",
        name: "Test legislation source",
      },
      {
        id: runnerSourceId,
        adapterKey: "test-runner",
        name: "Test legislation runner source",
      },
      {
        id: heldCursorSourceId,
        adapterKey: "test-runner-held-cursor",
        name: "Test legislation held-cursor source",
        syncCursor: "page-1",
      },
      {
        id: coverageSourceId,
        adapterKey: "test-runner-coverage",
        name: "Test legislation coverage source",
      },
    ]);

    // Test shim: run each scopedDb callback directly against the pglite db.
    scopedDb = ((fn: (tx: unknown) => unknown) =>
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only ScopedDb shim
      fn(db)) as unknown as ScopedDb;
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

const docInput = (fulltext: string) => ({
  sourceId,
  eli: "SK/2020/40",
  title: "Civil Code",
  country: "SVK",
  language: "sk",
  documentType: "act",
  status: "current" as const,
  effectiveDate: "2020-01-01",
  version: { type: "unversioned" } as const,
  fulltext,
  rawHash: Bun.SHA256.hash(fulltext, "hex"),
});

/** Narrow to the branch that wrote a row; anything else fails the test. */
const stored = (result: ProcessLegislationResult) => {
  if (result.type !== "stored") {
    throw new Error(`expected a stored document, got ${result.type}`);
  }
  return result;
};

/** Records what the object-storage write was asked to persist. */
const recordingRawWriter = () => {
  const calls: Parameters<WriteRawSourcePayload>[0][] = [];
  const write: WriteRawSourcePayload = async (options) => {
    calls.push(options);
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(options.data);
    return await Promise.resolve(
      `${options.owner.family}/raw/${options.owner.sourceId}/${hasher.digest("hex")}`,
    );
  };
  return { calls, write };
};

test("ingesting a legislation document inserts a row with its fields", async () => {
  // Its own ELI: the suite shares one database, so a test that asserts an
  // insert cannot key on a row the upsert tests below also write.
  const result = stored(
    await processLegislationDocument(
      { ...docInput("the obligations of the parties"), eli: "SK/2020/39" },
      scopedDb,
    ),
  );
  expect(result.inserted).toBe(true);
  expect(result.skipped).toBe(false);

  const [row] = await db
    .select({
      eli: legislationDocuments.eli,
      status: legislationDocuments.status,
      country: legislationDocuments.country,
      sourceHash: legislationDocuments.sourceHash,
    })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, result.id));
  expect(row?.eli).toBe("SK/2020/39");
  expect(row?.status).toBe("current");
  expect(row?.country).toBe("SVK");
  expect(row?.sourceHash).toBeTruthy();
});

test("re-ingesting identical content is skipped (source-hash dedup)", async () => {
  const first = stored(
    await processLegislationDocument(
      docInput("a stable consolidated text"),
      scopedDb,
    ),
  );
  const again = stored(
    await processLegislationDocument(
      docInput("a stable consolidated text"),
      scopedDb,
    ),
  );
  expect(again.id).toBe(first.id);
  expect(again.skipped).toBe(true);
  expect(again.inserted).toBe(false);
});

test("changed content updates the same row (new consolidation text)", async () => {
  const first = stored(
    await processLegislationDocument(docInput("original wording"), scopedDb),
  );
  const updated = stored(
    await processLegislationDocument(docInput("amended wording"), scopedDb),
  );
  expect(updated.id).toBe(first.id);
  expect(updated.skipped).toBe(false);
  expect(updated.inserted).toBe(false);
});

test("metadata-only change updates the row (same text, new status)", async () => {
  const first = stored(
    await processLegislationDocument(
      docInput("text that does not change"),
      scopedDb,
    ),
  );
  const updated = stored(
    await processLegislationDocument(
      {
        ...docInput("text that does not change"),
        status: "repealed",
      },
      scopedDb,
    ),
  );
  expect(updated.id).toBe(first.id);
  expect(updated.skipped).toBe(false);
  expect(updated.inserted).toBe(false);

  const [row] = await db
    .select({ status: legislationDocuments.status })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, first.id));
  expect(row?.status).toBe("repealed");
});

test("a publisher's last day in force is stored as the corpus's exclusive close", async () => {
  // eSbírka closes the pre-flexinovela zákoník práce consolidation on
  // 2025-05-31, its last day in force. The row has to close on 2025-06-01,
  // or a point-in-time read of 2025-05-31 finds no version; the conversion
  // happens here, once, and never in a connector.
  const consolidation = (end: "2025-05-31" | "2025-06-01") => ({
    ...docInput("pre-flexinovela wording"),
    eli: "eli/cz/sb/2006/262",
    version: {
      type: "consolidation" as const,
      validFrom: "2025-01-01",
      end: { type: "last-day-in-force" as const, on: end },
    },
  });
  const first = stored(
    await processLegislationDocument(consolidation("2025-05-31"), scopedDb),
  );
  const [row] = await db
    .select({
      versionValidFrom: legislationDocuments.versionValidFrom,
      versionValidTo: legislationDocuments.versionValidTo,
    })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, first.id));
  expect(row).toEqual({
    versionValidFrom: "2025-01-01",
    versionValidTo: "2025-06-01",
  });

  // The stored close is in the dedup hash: a publisher that moves the last
  // day refreshes the row rather than dedup-skipping on the same text.
  const moved = stored(
    await processLegislationDocument(consolidation("2025-06-01"), scopedDb),
  );
  expect(moved.id).toBe(first.id);
  expect(moved.skipped).toBe(false);
});

test("a version whose window does not meet its neighbour's is reported at ingest", async () => {
  const consolidation = (
    validFrom: string,
    end: { type: "exclusive"; on: string } | { type: "open" },
  ) => ({
    ...docInput(`wording from ${validFrom}`),
    eli: "eli/cz/sb/2000/1",
    version: { type: "consolidation" as const, validFrom, end },
  });
  const reported = spyOn(logger, "error");
  try {
    // Two windows that meet edge to edge: nothing to report, in either order
    // of arrival.
    stored(
      await processLegislationDocument(
        consolidation("2020-01-01", { type: "exclusive", on: "2021-01-01" }),
        scopedDb,
      ),
    );
    stored(
      await processLegislationDocument(
        consolidation("2021-01-01", { type: "exclusive", on: "2022-01-01" }),
        scopedDb,
      ),
    );
    expect(reported).not.toHaveBeenCalled();

    // A third that opens the day after the second closes: the shape of an
    // inclusive end date passed through as the exclusive bound. Declaring it
    // `exclusive` is the connector's mistake, and this is where it surfaces.
    stored(
      await processLegislationDocument(
        consolidation("2022-01-02", { type: "open" }),
        scopedDb,
      ),
    );
    expect(reported).toHaveBeenCalledTimes(1);
    expect(reported.mock.calls[0]?.[0]).toBe(
      "legislation.ingestion.version_window_discontiguous",
    );
    expect(reported.mock.calls[0]?.[1]).toMatchObject({
      eli: "eli/cz/sb/2000/1",
      earlierValidFrom: "2021-01-01",
      earlierValidTo: "2022-01-01",
      laterValidFrom: "2022-01-02",
      junction: "inclusive-end",
    });
  } finally {
    reported.mockRestore();
  }
});

test("a changed observation fingerprint alone refreshes the row", async () => {
  const base = {
    ...docInput("wording a later parser will read differently"),
    eli: "SK/2020/41",
  };
  const first = stored(await processLegislationDocument(base, scopedDb));
  // Everything the parser produced is identical; only the publisher's own
  // payload moved. Without rawHash in the dedup hash this is a permanent
  // skip, and the row can never be refreshed once the parser catches up.
  const refreshed = stored(
    await processLegislationDocument(
      { ...base, rawHash: `${base.rawHash}-v2` },
      scopedDb,
    ),
  );
  expect(refreshed.id).toBe(first.id);
  expect(refreshed.skipped).toBe(false);
});

test("the publisher's payload round-trips onto the row", async () => {
  const sourceRaw =
    '<html lang="sk"><body><div class="paragraf" id="paragraf-1">§ 1</div></body></html>';
  const raw = recordingRawWriter();
  const result = stored(
    await processLegislationDocument(
      {
        ...docInput("the consolidated wording"),
        eli: "SK/2020/42",
        sourceRaw,
        sourceRawContentType: "text/html; charset=utf-8",
      },
      scopedDb,
      { writeSourceRaw: raw.write },
    ),
  );

  expect(raw.calls).toHaveLength(1);
  expect(raw.calls[0]?.data).toBe(sourceRaw);
  expect(raw.calls[0]?.contentType).toBe("text/html; charset=utf-8");
  expect(raw.calls[0]?.owner.family).toBe("legislation");

  const [row] = await db
    .select({
      sourceRawS3Key: legislationDocuments.sourceRawS3Key,
      sourceRawContentType: legislationDocuments.sourceRawContentType,
    })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, result.id));
  const expectedKey = `legislation/raw/${sourceId}/${Bun.SHA256.hash(sourceRaw, "hex")}`;
  expect(row?.sourceRawS3Key).toBe(expectedKey);
  expect(row?.sourceRawContentType).toBe("text/html; charset=utf-8");
});

test("a later observation without a payload keeps the stored one", async () => {
  const sourceRaw = "<html><body>original capture</body></html>";
  const raw = recordingRawWriter();
  const base = { ...docInput("first wording"), eli: "SK/2020/43", sourceRaw };
  const first = stored(
    await processLegislationDocument(base, scopedDb, {
      writeSourceRaw: raw.write,
    }),
  );
  const refreshed = stored(
    await processLegislationDocument(
      { ...docInput("second wording"), eli: "SK/2020/43" },
      scopedDb,
      { writeSourceRaw: raw.write },
    ),
  );
  expect(refreshed.id).toBe(first.id);

  const [row] = await db
    .select({ sourceRawS3Key: legislationDocuments.sourceRawS3Key })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, first.id));
  expect(row?.sourceRawS3Key).toBe(
    `legislation/raw/${sourceId}/${Bun.SHA256.hash(sourceRaw, "hex")}`,
  );
});

test("a failed payload write stores no row at all", async () => {
  const failing: WriteRawSourcePayload = async () =>
    await Promise.reject(new Error("object storage unavailable"));
  const result = await processLegislationDocument(
    {
      ...docInput("wording whose payload cannot be stored"),
      eli: "SK/2020/44",
      sourceRaw: "<html><body>unstorable</body></html>",
    },
    scopedDb,
    { writeSourceRaw: failing },
  );
  expect(result.type).toBe("source-raw-write-failed");

  const rows = await db
    .select({ id: legislationDocuments.id })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.eli, "SK/2020/44"));
  expect(rows).toHaveLength(0);
});

const PUBLISHER_ORIGIN = "https://legislation.example.gov";

const runnerDocument = (
  eli: string,
  documentUrl: string,
): LegislationDocumentInput => ({
  sourceId: runnerSourceId,
  eli,
  title: "An act",
  country: "SVK",
  language: "sk",
  version: { type: "unversioned" },
  fulltext: "the wording",
  documentUrl,
  rawHash: Bun.SHA256.hash(eli, "hex"),
});

const runnerAdapter = (
  page: LegislationSyncPage,
): LegislationSourceAdapter => ({
  key: "test-runner",
  name: "Test runner adapter",
  outboundHostPolicy: { type: "exact-origin", origins: [PUBLISHER_ORIGIN] },
  fetchPage: async () => await Promise.resolve(Result.ok(page)),
  minRequestIntervalMs: 0,
  getTotalCount: async () =>
    await Promise.resolve({ type: "count", total: 2 } as const),
  reconciliation: {
    type: "unsupported",
    reason: "the fake publishes no addressable slices",
  },
});

test("a document URL off the adapter's declared origins is nulled, not dropped", async () => {
  const result = await runLegislationIngestion({
    adapter: runnerAdapter({
      documents: [
        runnerDocument("SVK/act/1", `${PUBLISHER_ORIGIN}/act/1`),
        // The shape the URL boundary exists for: a publisher payload that
        // points the ingestion worker at the instance metadata service.
        runnerDocument("SVK/act/2", "http://169.254.169.254/latest/meta-data/"),
      ],
      nextCursor: null,
    }),
    source: { id: runnerSourceId, syncCursor: null },
    scopedDb,
    signal: new AbortController().signal,
  });

  expect(result.urlsRefused).toBe(1);
  // Both documents are stored: the statute survives its off-policy link.
  expect(result.inserted).toBe(2);

  const rows = await db
    .select({
      eli: legislationDocuments.eli,
      documentUrl: legislationDocuments.documentUrl,
    })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.sourceId, runnerSourceId))
    .orderBy(legislationDocuments.eli);
  expect(rows).toEqual([
    { eli: "SVK/act/1", documentUrl: `${PUBLISHER_ORIGIN}/act/1` },
    { eli: "SVK/act/2", documentUrl: null },
  ]);
});

test("a document naming a foreign source is stored under the source being run", async () => {
  const result = await runLegislationIngestion({
    adapter: runnerAdapter({
      documents: [
        {
          ...runnerDocument("SVK/act/3", `${PUBLISHER_ORIGIN}/act/3`),
          // What an adapter that guessed its own identity would emit.
          sourceId,
        },
      ],
      nextCursor: null,
    }),
    source: { id: runnerSourceId, syncCursor: null },
    scopedDb,
    signal: new AbortController().signal,
  });
  expect(result.inserted).toBe(1);

  const rows = await db
    .select({ sourceId: legislationDocuments.sourceId })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.eli, "SVK/act/3"));
  expect(rows).toEqual([{ sourceId: runnerSourceId }]);
});

test("a page the adapter could not fetch holds the cursor", async () => {
  const adapter = runnerAdapter({ documents: [], nextCursor: null });
  let fetchCalls = 0;
  const failing: LegislationSourceAdapter = {
    ...adapter,
    fetchPage: async () => {
      fetchCalls += 1;
      return await Promise.resolve(
        Result.err(
          new AdapterFetchError({
            message: "publisher unavailable",
            adapterKey: "test-runner",
            cursor: "page-1",
          }),
        ),
      );
    },
  };
  const result = await runLegislationIngestion({
    adapter: failing,
    source: { id: heldCursorSourceId, syncCursor: "page-1" },
    scopedDb,
    signal: new AbortController().signal,
  });
  // The page this cursor names was never read, so advancing past it would
  // skip whatever it held, permanently: a forward-only cursor never returns.
  expect(result.nextCursor).toBe("page-1");
  expect(result.inserted).toBe(0);
  // One attempt: without the break the cycle would re-ask a down publisher
  // once per page budget, and the two assertions above would still hold.
  expect(fetchCalls).toBe(1);
});

test("coverage is reported only for a page that fully persisted", async () => {
  const coverage = { slice: "2026-08-18", reported: 1, collected: 1 };
  const page = {
    documents: [
      {
        ...runnerDocument("SVK/act/4", `${PUBLISHER_ORIGIN}/act/4`),
        sourceRaw: "<html><body>unstorable</body></html>",
      },
    ],
    nextCursor: null,
    coverage,
  };
  const failing: WriteRawSourcePayload = async () =>
    await Promise.reject(new Error("object storage unavailable"));

  const held = await runLegislationIngestion({
    adapter: runnerAdapter(page),
    source: { id: coverageSourceId, syncCursor: null },
    scopedDb,
    signal: new AbortController().signal,
    writeSourceRaw: failing,
  });
  // `collected` counts durably held records, so a page whose writes failed
  // must report none of it.
  expect(held.coverage).toEqual([]);

  const raw = recordingRawWriter();
  const settled = await runLegislationIngestion({
    adapter: runnerAdapter(page),
    source: { id: coverageSourceId, syncCursor: null },
    scopedDb,
    signal: new AbortController().signal,
    writeSourceRaw: raw.write,
  });
  expect(settled.coverage).toEqual([coverage]);
});
