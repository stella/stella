import { panic, Result } from "better-result";
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

import { createSha256 } from "@stll/sha256/node";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawRawSweeps,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import {
  decodeSourceRawEnvelope,
  decodeSourceRawEnvelopeObjects,
  EMPTY_AST,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import { CitationScopesRejectedError } from "@/api/handlers/case-law/ingestion/citation-scopes";
import {
  processDecision,
  processStoredDecision,
} from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { DECISION_REFRESH } from "@/api/handlers/case-law/ingestion/pipeline/types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// What a re-observation of a decision costs in object storage. The bucket
// keeps every version it is written, so a PUT of bytes a key already holds is
// not a no-op: it is a second copy. The invariant is that an unchanged
// payload never produces a stored version, and a re-observation the row
// already records produces no request at all.

let fake: FakeS3;

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
});

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the pipeline expects.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

const PDF = new TextEncoder().encode("%PDF-1.4 a decision the court serves");

const createSource = async (): Promise<SafeId<"caseLawSource">> => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `source-raw-writes-${sourceId}`,
    name: "source raw writes fixture",
  });
  return sourceId;
};

type ObserveOptions = {
  sourceId: SafeId<"caseLawSource">;
  /** The listing part; changing it changes the envelope, not the file. */
  listing: string;
  order: bigint;
};

/** One observation of the same decision, as a crawl or a replay feeds it. */
const observe = async ({ sourceId, listing, order }: ObserveOptions) =>
  await processDecision({
    input: plainTextIngestionResult({
      caseNumber: "I. ÚS 1/2026",
      sourceDocumentId: "document-1",
      court: "Ústavný súd Slovenskej republiky",
      country: "SVK",
      language: "sk",
      fulltext: "Rozhodnutie o veci samej.",
      metadata: {},
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      rawHash: createSha256().update(listing).digest("hex"),
      documentAst: EMPTY_AST,
      sourceRaw: encodeSourceRawEnvelope({ listing }),
      sourceRawObjects: {
        "document-file": { bytes: PDF, contentType: "application/pdf" },
      },
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    }),
    sourceId,
    scopedDb,
    observedAt: new Date(),
    observationOrder: order,
    // Past the source-hash skip, the way a replay or a changed listing
    // reaches the raw write: the write itself must hold the invariant.
    refresh: DECISION_REFRESH.ALWAYS,
  });

const puts = () => fake.requests.filter(({ method }) => method === "PUT");

test("a planning rejection schedules the new decision's uploaded raw for sweeping", async () => {
  const sourceId = await createSource();
  const failed = await Result.tryPromise({
    try: async () =>
      await processDecision({
        input: plainTextIngestionResult({
          caseNumber: "raw-planning-rejection",
          sourceDocumentId: "raw-planning-rejection",
          court: "Ústavný súd Slovenskej republiky",
          country: "SVK",
          language: "sk",
          fulltext: "Rozhodnutie o veci samej.",
          metadata: {},
          textFields: absentDecisionTextFields(
            TEXT_ABSENCE_REASON.NOT_PUBLISHED,
          ),
          rawHash: "raw-planning-rejection",
          documentAst: EMPTY_AST,
          citationScopes: [],
          sourceRaw: "publisher raw",
        }),
        sourceId,
        scopedDb,
        observedAt: new Date(),
        observationOrder: 1n,
      }),
    catch: (cause) => cause,
  });
  if (!Result.isError(failed)) {
    expect.unreachable("Scopes without an AST must reject planning");
  }
  expect(failed.error).toBeInstanceOf(CitationScopesRejectedError);
  expect(puts()).toHaveLength(1);
  const sweeps = await db
    .select()
    .from(caseLawRawSweeps)
    .where(eq(caseLawRawSweeps.sourceId, sourceId));
  expect(sweeps).toHaveLength(1);
  const decisions = await db
    .select()
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  expect(decisions).toHaveLength(0);
});

test("re-observing an unchanged decision with a publisher file writes nothing", async () => {
  const sourceId = await createSource();

  const first = await observe({ sourceId, listing: "{}", order: 1n });
  expect(first.status).toBe("complete");
  // The file and the envelope that names it; the fixture reaches the write.
  expect(puts()).toHaveLength(2);
  fake.requests.length = 0;

  const second = await observe({ sourceId, listing: "{}", order: 2n });

  expect(second.status).toBe("complete");
  expect(puts()).toEqual([]);
  expect([...fake.versions.values()]).toEqual([1, 1]);
});

test("a changed envelope over the same file adds no version of the file", async () => {
  const sourceId = await createSource();
  await observe({ sourceId, listing: '{"a":1}', order: 1n });
  const [before] = await db
    .select({ key: caseLawDecisions.sourceRawS3Key })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));

  const changed = await observe({ sourceId, listing: '{"a":2}', order: 2n });

  expect(changed.status).toBe("complete");
  const [after] = await db
    .select({ key: caseLawDecisions.sourceRawS3Key })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  // The envelope did change, so this observation did reach the write.
  expect(after?.key).not.toBe(before?.key);
  const fileVersions = [...fake.versions.entries()].filter(
    ([id]) => id.includes("/documents/") && !id.includes("/payloads/"),
  );
  expect(fileVersions.map(([, count]) => count)).toEqual([1]);

  // Flipping back to an envelope stored before, which the row no longer
  // records, writes no version of that envelope either.
  fake.requests.length = 0;
  await observe({ sourceId, listing: '{"a":1}', order: 3n });
  const [back] = await db
    .select({ key: caseLawDecisions.sourceRawS3Key })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  expect(back?.key).toBe(before?.key);
  expect(puts().map(({ ifNoneMatch }) => ifNoneMatch)).toEqual(["*", "*"]);
  expect(Math.max(...fake.versions.values())).toBe(1);
});

const partialDocumentObservation = () =>
  plainTextIngestionResult({
    caseNumber: "I. ÚS 1/2026",
    sourceDocumentId: "document-1",
    court: "Ústavný súd Slovenskej republiky",
    country: "SVK",
    language: "sk",
    isListingOnly: true,
    metadata: {},
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: "partial-document-observation",
    documentAst: EMPTY_AST,
    sourceRaw: encodeSourceRawEnvelope({
      listing: '{"id":1}',
      detail: '{"id":1,"document":true}',
    }),
    sourceRawObjects: {
      "document-file": {
        bytes: new TextEncoder().encode("%PDF-1.7 unreadable fetched document"),
        contentType: "application/pdf",
      },
    },
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });

const decisionForSource = async (sourceId: SafeId<"caseLawSource">) => {
  const decision = (
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId))
  ).at(0);
  if (decision === undefined) {
    panic("the enriched decision must exist");
  }
  return decision;
};

test("archives a partial observation's fetched document while retaining the enriched row", async () => {
  const sourceId = await createSource();
  await observe({ sourceId, listing: "{}", order: 1n });
  const before = await decisionForSource(sourceId);
  expect(before.fulltext?.length ?? 0).toBeGreaterThan(0);
  expect(before.sourceRawS3Key).not.toBeNull();
  fake.requests.length = 0;
  const input = partialDocumentObservation();
  const outcome = await processDecision({
    input,
    sourceId,
    scopedDb,
    observationOrder: 2n,
    observedAt: new Date("2026-10-29T00:00:00.000Z"),
  });
  expect(outcome.status).toBe("complete");
  expect(puts()).toHaveLength(2);
  const payload = puts().find(({ key }) => key.includes("/payloads/"));
  expect(payload).toBeDefined();
  if (payload === undefined) {
    panic("the partial envelope must be stored");
  }
  expect(payload.key).not.toBe(before.sourceRawS3Key);
  const envelope = new TextDecoder().decode(
    fake.objects.get(`${payload.bucket}/${payload.key}`)?.bytes,
  );
  expect(decodeSourceRawEnvelope(envelope)).toEqual(
    decodeSourceRawEnvelope(input.sourceRaw ?? ""),
  );
  const ref = decodeSourceRawEnvelopeObjects(envelope)["document-file"];
  expect(ref).toBeDefined();
  if (ref === undefined) {
    panic("the partial envelope must name its fetched document");
  }
  expect(ref.location).toContain(`/documents/${before.id}/`);
  expect(fake.objects.get(`${payload.bucket}/${ref.location}`)?.bytes).toEqual(
    input.sourceRawObjects?.["document-file"]?.bytes,
  );
  const after = await decisionForSource(sourceId);
  expect(after).toMatchObject({
    sourceRawS3Key: before.sourceRawS3Key,
    sourceRawContentType: before.sourceRawContentType,
    sourceHash: before.sourceHash,
    fulltext: before.fulltext,
    documentAst: before.documentAst,
    metadata: before.metadata,
    contentHash: before.contentHash,
    updatedAt: before.updatedAt,
    sourceObservationOrder: 2n,
    sourceObservationHash: input.rawHash,
  });
});

test.each(["document", "envelope"] as const)(
  "a failed partial %s archive holds the observation watermark",
  async (failedPart) => {
    const sourceId = await createSource();
    await observe({ sourceId, listing: "{}", order: 1n });
    const before = await decisionForSource(sourceId);
    fake.requests.length = 0;
    fake.failNext({
      method: "PUT",
      code: "AccessDenied",
      status: 403,
      ...(failedPart === "envelope" ? { keyIncludes: "/payloads/" } : {}),
    });
    const outcome = await processDecision({
      input: partialDocumentObservation(),
      sourceId,
      scopedDb,
      observationOrder: 2n,
      observedAt: new Date("2026-10-29T00:00:00.000Z"),
    });
    expect(outcome).toEqual({
      status: "retryable",
      inserted: false,
      reason: "source-raw-write",
    });
    expect(puts()).toHaveLength(failedPart === "document" ? 1 : 2);
    expect(await decisionForSource(sourceId)).toEqual(before);
  },
);

test("stored-input partial replay never archives raw objects", async () => {
  const sourceId = await createSource();
  await observe({ sourceId, listing: "{}", order: 1n });
  const before = await decisionForSource(sourceId);
  if (before.sourceRawS3Key === null) {
    panic("the enriched decision must retain its raw pointer");
  }
  fake.requests.length = 0;
  const outcome = await processStoredDecision({
    input: partialDocumentObservation(),
    sourceId,
    scopedDb,
    observationOrder: 2n,
    observedAt: new Date("2026-10-29T00:00:00.000Z"),
    decisionId: before.id,
    sourceRawS3Key: before.sourceRawS3Key,
  });
  expect(outcome.status).toBe("complete");
  expect(puts()).toEqual([]);
  expect((await decisionForSource(sourceId)).sourceRawS3Key).toBe(
    before.sourceRawS3Key,
  );
});
