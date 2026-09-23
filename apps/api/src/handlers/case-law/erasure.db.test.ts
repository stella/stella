import { Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCorpusPackRefs,
  caseLawCorpusTombstones,
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawRawSweeps,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { ensureCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { deleteCorpusDocument as realDeleteCorpusDocument } from "@/api/lib/legal-search/corpus-storage";
import {
  openRawSourceWriteWindow,
  RAW_SOURCE_FAMILY,
  rawDocumentPrefix,
  writeSourceBinary,
} from "@/api/lib/legal-search/raw-source-storage";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Erasure reaches the corpus index through the projection queue: scrubbing the
 * canonical content moves the decision's desired state to an erase, which the
 * projection worker applies. Nothing else on the decision records where a copy
 * was written, so this transition is the whole guarantee that a redacted
 * decision leaves the index.
 */

const SERVING_GENERATION = "case_law_v6";
const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-0000000002a1",
);
const DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-0000000002a2",
);
const OTHER_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-0000000002a3",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
let fakeS3: FakeS3;

beforeAll(async () => {
  fakeS3 = startFakeS3();
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = asTestRaw<ScopedDb>(
    async (callback: (tx: typeof db) => Promise<unknown>) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx))),
  );
});

afterAll(async () => {
  fakeS3.stop();
  await client.close();
});

beforeEach(async () => {
  fakeS3.objects.clear();
  await db.delete(caseLawCorpusTombstones).where(sql`true`);
  await db.delete(caseLawCorpusPackRefs).where(sql`true`);
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(caseLawIndexJobs).where(sql`true`);
  await db.delete(caseLawRawSweeps).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);

  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "erasure",
    name: "Erasure",
  });
  await db.insert(caseLawDecisions).values({
    id: DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "4 As 3/2008",
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
    fulltext: "Osobní údaj.",
    contentHash: "a".repeat(64),
  });
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: SERVING_GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS[SERVING_GENERATION],
    ),
    status: "serving",
  });
  await db.transaction(async (tx) => {
    await ensureCorpusProjectionDesiredStateTx(
      asTestRaw(tx),
      { family: "case_law", entityId: DECISION_ID },
      SERVING_GENERATION,
    );
  });
});

test("redaction queues the erase the projection worker applies", async () => {
  const before = await db
    .select({ desiredAction: corpusIndexProjectionStates.desiredAction })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
  // Without this the assertion below would pass on a state that was never
  // an upsert to begin with.
  expect(before).toEqual([{ desiredAction: "upsert" }]);

  const outcome = await redactCaseLawDecision({
    decisionId: DECISION_ID,
    scopedDb,
  });

  expect(Result.isOk(outcome) && outcome.value).toEqual({
    type: "redacted",
    erasure: "deleted",
    legacyRaw: "none",
  });
  expect(
    await db
      .select({
        desiredAction: corpusIndexProjectionStates.desiredAction,
        desiredFingerprint: corpusIndexProjectionStates.desiredFingerprint,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID)),
  ).toEqual([{ desiredAction: "erase", desiredFingerprint: null }]);
  expect(
    await db
      .select({
        contentHash: caseLawDecisions.contentHash,
        fulltext: caseLawDecisions.fulltext,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, DECISION_ID)),
  ).toEqual([{ contentHash: null, fulltext: null }]);
});

test("redaction records one audit row naming no generation", async () => {
  await redactCaseLawDecision({ decisionId: DECISION_ID, scopedDb });

  expect(
    await db
      .select({
        generation: caseLawIndexJobs.generation,
        operation: caseLawIndexJobs.operation,
        status: caseLawIndexJobs.status,
      })
      .from(caseLawIndexJobs)
      .where(eq(caseLawIndexJobs.decisionId, DECISION_ID)),
  ).toEqual([{ generation: null, operation: "redact", status: "succeeded" }]);
});

test("redaction of packed payloads tombstones every address it cannot delete", async () => {
  const packKey = "legal-corpus/packs/jurisdiction=CZE/f00d.stlpack";
  const addresses = {
    textS3Key: `pack:${packKey}@0+16#${"a".repeat(64)}`,
    normalizedS3Key: `pack:${packKey}@16+16#${"b".repeat(64)}`,
    astS3Key: `pack:${packKey}@32+16#${"c".repeat(64)}`,
  };
  await db
    .update(caseLawDecisions)
    .set(addresses)
    .where(eq(caseLawDecisions.id, DECISION_ID));
  await db.insert(caseLawCorpusPackRefs).values(
    (["text", "sections", "ast"] as const).map((kind, index) => ({
      decisionId: DECISION_ID,
      kind,
      packKey,
      location: Object.values(addresses)[index] ?? "",
    })),
  );
  const deleted: string[] = [];

  const outcome = await redactCaseLawDecision({
    decisionId: DECISION_ID,
    scopedDb,
    deleteCorpus: async (keys, options) =>
      await realDeleteCorpusDocument(keys, {
        ...options,
        deleteObject: async (key) => {
          deleted.push(key);
          await Promise.resolve();
        },
      }),
  });

  // The pack carries other decisions, so nothing is deleted; the erasure is
  // the refusal to serve those addresses again.
  expect(Result.isOk(outcome) && outcome.value).toEqual({
    type: "redacted",
    erasure: "tombstoned",
    legacyRaw: "none",
  });
  expect(deleted).toEqual([]);
  expect(
    (
      await db
        .select({ location: caseLawCorpusTombstones.location })
        .from(caseLawCorpusTombstones)
        .where(eq(caseLawCorpusTombstones.decisionId, DECISION_ID))
    ).map(({ location }) => location),
  ).toEqual(expect.arrayContaining(Object.values(addresses)));
  // A tombstoned member no longer keeps its pack alive for a rewrite.
  expect(
    await db
      .select({ packKey: caseLawCorpusPackRefs.packKey })
      .from(caseLawCorpusPackRefs)
      .where(eq(caseLawCorpusPackRefs.decisionId, DECISION_ID)),
  ).toEqual([]);
  expect(
    await db
      .select({
        textS3Key: caseLawDecisions.textS3Key,
        normalizedS3Key: caseLawDecisions.normalizedS3Key,
        astS3Key: caseLawDecisions.astS3Key,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, DECISION_ID)),
  ).toEqual([{ textS3Key: null, normalizedS3Key: null, astS3Key: null }]);
  expect(
    await db
      .select({ detail: caseLawIndexJobs.detail })
      .from(caseLawIndexJobs)
      .where(eq(caseLawIndexJobs.decisionId, DECISION_ID)),
  ).toEqual([{ detail: expect.stringContaining(packKey) }]);
});

test("redaction erases the decision's publisher files and no other decision's", async () => {
  await db.insert(caseLawDecisions).values({
    id: OTHER_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "4 As 4/2008",
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
  });
  // One file served for both decisions, and one this decision's envelope
  // named before a later observation replaced it.
  const shared = new TextEncoder().encode("%PDF-1.4 joined proceedings");
  const superseded = new TextEncoder().encode("%PDF-1.4 earlier version");
  const owner = {
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId: SOURCE_ID,
    contentType: "application/pdf",
    window: openRawSourceWriteWindow(),
  } as const;
  await writeSourceBinary({ ...owner, documentId: DECISION_ID, bytes: shared });
  await writeSourceBinary({
    ...owner,
    documentId: DECISION_ID,
    bytes: superseded,
  });
  const kept = await writeSourceBinary({
    ...owner,
    documentId: OTHER_DECISION_ID,
    bytes: shared,
  });
  const keysUnder = (documentId: string): string[] =>
    [...fakeS3.objects.keys()].filter((id) =>
      id.includes(rawDocumentPrefix({ ...owner, documentId })),
    );
  // Identical bytes are held twice, once per owner, or the independence
  // asserted below would be vacuous.
  expect(keysUnder(DECISION_ID)).toHaveLength(2);
  expect(keysUnder(OTHER_DECISION_ID)).toHaveLength(1);

  const outcome = await redactCaseLawDecision({
    decisionId: DECISION_ID,
    scopedDb,
  });

  expect(Result.isOk(outcome) && outcome.value).toEqual({
    type: "redacted",
    erasure: "deleted",
    legacyRaw: "none",
  });
  expect(keysUnder(DECISION_ID)).toEqual([]);
  expect(keysUnder(OTHER_DECISION_ID)).toEqual([
    `${envBase.S3_BUCKET}/${kept.location}`,
  ]);
});

test("redaction clears the inline raw column a row may still hold", async () => {
  await db
    .update(caseLawDecisions)
    .set({ sourceRaw: "<html>Osobní údaj.</html>" })
    .where(eq(caseLawDecisions.id, DECISION_ID));

  await redactCaseLawDecision({ decisionId: DECISION_ID, scopedDb });

  expect(
    await db
      .select({ sourceRaw: caseLawDecisions.sourceRaw })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, DECISION_ID)),
  ).toEqual([{ sourceRaw: null }]);
});

test("a failed file delete keeps the redaction a retry target", async () => {
  const owner = {
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId: SOURCE_ID,
    documentId: DECISION_ID,
    window: openRawSourceWriteWindow(),
  } as const;
  const file = await writeSourceBinary({
    ...owner,
    bytes: new TextEncoder().encode("%PDF-1.4 a decision"),
    contentType: "application/pdf",
  });
  await db
    .update(caseLawDecisions)
    .set({ sourceRawS3Key: "case-law/raw/envelope", sourceRawContentType: "x" })
    .where(eq(caseLawDecisions.id, DECISION_ID));
  fakeS3.failNext({
    method: "DELETE",
    code: "AccessDenied",
    status: 403,
    key: file.location,
  });

  const outcome = await redactCaseLawDecision({
    decisionId: DECISION_ID,
    scopedDb,
  });

  expect(Result.isOk(outcome) && outcome.value).toMatchObject({
    type: "corpus-objects-remain",
  });
  expect(
    await db
      .select({ sourceRawS3Key: caseLawDecisions.sourceRawS3Key })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, DECISION_ID)),
  ).toEqual([{ sourceRawS3Key: "case-law/raw/envelope" }]);
  expect(fakeS3.objects.has(`${envBase.S3_BUCKET}/${file.location}`)).toBe(
    true,
  );
});
