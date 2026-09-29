import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  corpusIndexGenerations,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import {
  processLegislationDocument,
  type LegislationCorpusDependencies,
} from "@/api/handlers/legislation/ingestion";
import {
  LEGISLATION_WITHDRAWAL_BATCH_LIMIT,
  withdrawLegislationVersions,
  type LegislationWithdrawal,
} from "@/api/handlers/legislation/withdrawal";
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The census's withdrawal: a compare-and-set tombstone that erases the
 * version's search projection in the same transaction, replays as a no-op,
 * never overwrites a newer observation, and is lifted in place by a live
 * listing of the version.
 */

const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000e01",
);
const NAMESPACE = "esel";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const corpus = {
  mode: "dual-write",
  write: async (input) => {
    const plan = planCorpusDocumentWrite(input);
    return await Promise.resolve(
      plan.type === "put"
        ? { type: "written" as const, written: plan.written }
        : plan,
    );
  },
} satisfies LegislationCorpusDependencies;

const iriOf = (act: string) =>
  `https://example.test/esel-esb/eli/cz/sb/${act}/2020-01-01`;

const version = (act: string, text = `§ 1 Act ${act}`) =>
  ({
    sourceId: SOURCE_ID,
    eli: `eli/cz/sb/${act}`,
    title: `Act ${act}`,
    country: "CZE",
    language: "cs",
    version: {
      type: "consolidation",
      validFrom: "2020-01-01",
      end: { type: "exclusive", on: "2024-01-01" },
    },
    expression: { publisherId: `${NAMESPACE}:${iriOf(act)}` },
    fulltext: text,
    metadata: { versionIri: iriOf(act) },
    rawHash: `raw-${act}-${text}`,
  }) satisfies LegislationDocumentInput;

const store = async (input: LegislationDocumentInput) => {
  const result = await processLegislationDocument(input, scopedDb, { corpus });
  return result.type === "stored"
    ? result
    : panic(`expected a stored version, got ${result.type}`);
};

const stateOf = async (id: SafeId<"legislationDocument">) =>
  (
    await db
      .select({
        disposition: legislationDocuments.windowDisposition,
        basis: legislationDocuments.windowDispositionBasis,
        validFrom: legislationDocuments.versionValidFrom,
        validTo: legislationDocuments.versionValidTo,
        sourceHash: legislationDocuments.sourceHash,
        payloadRevision: legislationDocuments.payloadRevision,
        updatedAt: legislationDocuments.updatedAt,
        action: corpusIndexProjectionStates.desiredAction,
        epoch: corpusIndexProjectionStates.desiredEpoch,
        fingerprint: corpusIndexProjectionStates.desiredFingerprint,
      })
      .from(legislationDocuments)
      .innerJoin(
        corpusIndexProjectionStates,
        eq(corpusIndexProjectionStates.entityId, legislationDocuments.id),
      )
      .where(eq(legislationDocuments.id, id))
  ).at(0) ?? panic("the version has no projection state");

const withdrawalOf = (
  input: ReturnType<typeof version>,
  observedPayloadRevision: bigint,
  basis: LegislationWithdrawal["basis"] = "publisher-unlisted",
): LegislationWithdrawal => ({
  sourceId: input.sourceId,
  eli: input.eli,
  language: input.language,
  publisherId: input.expression.publisherId,
  basis,
  observedPayloadRevision,
});

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  await db.insert(legislationSources).values({
    id: SOURCE_ID,
    adapterKey: "withdrawal-test",
    name: "Withdrawal test",
    expressionNamespace: NAMESPACE,
  });
  await db.insert(corpusIndexGenerations).values({
    family: "legislation",
    generation: "legislation_v2",
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.legislation_v2,
    ),
    status: "building",
  });
});

afterAll(async () => {
  await client.close();
});

test("a withdrawal erases the projection in its own transaction, replays as a no-op, and a live listing restores the version in place", async () => {
  const input = version("2017/94");
  const stored = await store(input);
  const listed = await stateOf(stored.id);

  const [withdrawn] = await withdrawLegislationVersions(
    [withdrawalOf(input, listed.payloadRevision)],
    scopedDb,
  );
  const tombstone = await stateOf(stored.id);
  // The census re-sends what it decided; the row has moved on since.
  const [replayed] = await withdrawLegislationVersions(
    [withdrawalOf(input, listed.payloadRevision)],
    scopedDb,
  );
  const afterReplay = await stateOf(stored.id);
  const relisted = await store(input);
  const restored = await stateOf(stored.id);
  const relistedAgain = await store(input);

  expect(listed).toMatchObject({ disposition: "effective", action: "upsert" });
  expect(withdrawn).toEqual({ type: "withdrawn", id: stored.id });
  // Erased with no ingest in between, the window and dedup hash kept.
  expect(tombstone).toMatchObject({
    disposition: "withdrawn",
    basis: "publisher-unlisted",
    validFrom: listed.validFrom,
    validTo: listed.validTo,
    sourceHash: listed.sourceHash,
    payloadRevision: listed.payloadRevision + 1n,
    action: "erase",
    epoch: listed.epoch + 1n,
    fingerprint: null,
  });
  expect(replayed).toEqual({ type: "unchanged", id: stored.id });
  expect(afterReplay).toEqual(tombstone);
  // The identical listing gets past the unchanged-hash skip, keeps the UUID
  // and brings back the very projection the version had.
  expect(relisted).toMatchObject({ id: stored.id, skipped: false });
  expect(restored).toMatchObject({
    disposition: "effective",
    basis: null,
    sourceHash: listed.sourceHash,
    action: "upsert",
    fingerprint: listed.fingerprint,
  });
  expect(relistedAgain).toMatchObject({ id: stored.id, skipped: true });
  expect(await stateOf(stored.id)).toEqual(restored);
});

test("a withdrawal decided before a newer observation writes nothing", async () => {
  const input = version("2018/95");
  const stored = await store(input);
  const observed = await stateOf(stored.id);
  await store(version("2018/95", "§ 1 Amended wording."));
  const newer = await stateOf(stored.id);

  const [stale] = await withdrawLegislationVersions(
    [withdrawalOf(input, observed.payloadRevision)],
    scopedDb,
  );

  // The fixture reaches the fault: the observation really moved the row.
  expect(newer.payloadRevision).toBeGreaterThan(observed.payloadRevision);
  expect(stale).toEqual({
    type: "stale",
    id: stored.id,
    payloadRevision: newer.payloadRevision,
  });
  expect(await stateOf(stored.id)).toEqual(newer);
});

test("a withdrawal recorded without its projection is erased by the next one", async () => {
  const input = version("2019/96");
  const stored = await store(input);
  // A tombstone written outside the writer, so its projection still says
  // upsert.
  await db
    .update(legislationDocuments)
    .set({
      windowDisposition: "withdrawn",
      windowDispositionBasis: "publisher-unlisted",
    })
    .where(eq(legislationDocuments.id, stored.id));
  const unsynced = await stateOf(stored.id);

  const [replayed] = await withdrawLegislationVersions(
    [withdrawalOf(input, unsynced.payloadRevision)],
    scopedDb,
  );

  expect(unsynced.action).toBe("upsert");
  expect(replayed).toEqual({ type: "unchanged", id: stored.id });
  expect(await stateOf(stored.id)).toMatchObject({
    payloadRevision: unsynced.payloadRevision,
    action: "erase",
    fingerprint: null,
  });
});

test("a withdrawal names its version by id only, in bounded batches", async () => {
  const input = version("2020/97");
  const stored = await store(input);
  const listed = await stateOf(stored.id);

  const outcomes = await withdrawLegislationVersions(
    [
      // Another language of the same work, and an id no row carries.
      { ...withdrawalOf(input, listed.payloadRevision), language: "en" },
      {
        ...withdrawalOf(input, listed.payloadRevision),
        publisherId: `${NAMESPACE}:${iriOf("2020/97-other")}`,
      },
    ],
    scopedDb,
  );
  const oversized = Array.from(
    { length: LEGISLATION_WITHDRAWAL_BATCH_LIMIT + 1 },
    () => withdrawalOf(input, listed.payloadRevision),
  );

  expect(outcomes).toEqual([{ type: "missing" }, { type: "missing" }]);
  expect(await stateOf(stored.id)).toEqual(listed);
  await expect(
    withdrawLegislationVersions(oversized, scopedDb),
  ).rejects.toThrow("too many legislation withdrawals");
  expect(await stateOf(stored.id)).toEqual(listed);
});
