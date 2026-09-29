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
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  planCorpusDocumentWrite,
  type CorpusWriteOutcome,
} from "@/api/lib/legal-search/corpus-storage";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const sourceId = createSafeId<"legislationSource">();

const corpusWrite: LegislationCorpusDependencies["write"] = async (input) => {
  const plan = planCorpusDocumentWrite(input);
  switch (plan.type) {
    case "put":
      return await Promise.resolve({ type: "written", written: plan.written });
    case "skipped-empty":
    case "skipped-unchanged":
      return await Promise.resolve(plan);
    default:
      return plan satisfies never;
  }
};

const corpus = {
  mode: "dual-write",
  write: corpusWrite,
} satisfies LegislationCorpusDependencies;

const input = (
  status: NonNullable<LegislationDocumentInput["status"]>,
): LegislationDocumentInput => ({
  sourceId,
  eli: "eli/cz/sb/2012/89",
  title: "Občanský zákoník",
  country: "CZE",
  language: "cs",
  documentType: "act",
  status,
  effectiveDate: "2014-01-01",
  version: { type: "unversioned" },
  fulltext: "§ 1 Soukromé právo chrání důstojnost a svobodu člověka.",
  rawHash: `publisher-${status}`,
});

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));

  await db.insert(legislationSources).values({
    id: sourceId,
    adapterKey: "projection-ingestion-test",
    name: "Projection ingestion test",
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

test("a settled legislation write advances desired state and replay is a fixed point", async () => {
  const first = await processLegislationDocument(input("current"), scopedDb, {
    corpus,
  });
  if (first.type !== "stored") {
    throw new Error(`expected stored legislation, got ${first.type}`);
  }
  const initialState = (
    await db
      .select({
        epoch: corpusIndexProjectionStates.desiredEpoch,
        fingerprint: corpusIndexProjectionStates.desiredFingerprint,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, first.id))
  ).at(0);

  const refreshedInput = input("repealed");
  await processLegislationDocument(refreshedInput, scopedDb, { corpus });
  const refreshedState = (
    await db
      .select({
        action: corpusIndexProjectionStates.desiredAction,
        epoch: corpusIndexProjectionStates.desiredEpoch,
        fingerprint: corpusIndexProjectionStates.desiredFingerprint,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, first.id))
  ).at(0);

  await processLegislationDocument(refreshedInput, scopedDb, { corpus });
  const replay = (
    await db
      .select({
        epoch: legislationDocuments.projectionEpoch,
        status: legislationDocuments.status,
      })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, first.id))
  ).at(0);

  expect(initialState?.epoch).toBe(1n);
  expect(initialState?.fingerprint).not.toBeNull();
  expect(refreshedState?.action).toBe("upsert");
  expect(refreshedState?.epoch).toBe(2n);
  expect(refreshedState?.fingerprint).not.toBe(initialState?.fingerprint);
  expect(replay).toEqual({ epoch: 2n, status: "repealed" });
});

test("a failed corpus refresh advances erase state and a retry restores upsert", async () => {
  const first = await processLegislationDocument(
    { ...input("current"), eli: "eli/cz/sb/2012/90" },
    scopedDb,
    { corpus },
  );
  if (first.type !== "stored") {
    throw new Error(`expected stored legislation, got ${first.type}`);
  }

  const failingCorpus = {
    ...corpus,
    write: async (): Promise<CorpusWriteOutcome> =>
      await Promise.reject(new Error("object storage unavailable")),
  } satisfies LegislationCorpusDependencies;
  const changed = {
    ...input("current"),
    eli: "eli/cz/sb/2012/90",
    fulltext: "§ 1 Nové znění.",
    rawHash: "publisher-changed",
  };
  const failed = await processLegislationDocument(changed, scopedDb, {
    corpus: failingCorpus,
  });
  const erased = (
    await db
      .select({
        action: corpusIndexProjectionStates.desiredAction,
        epoch: corpusIndexProjectionStates.desiredEpoch,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, first.id))
  ).at(0);

  const retried = await processLegislationDocument(changed, scopedDb, {
    corpus,
  });
  const restored = (
    await db
      .select({
        action: corpusIndexProjectionStates.desiredAction,
        epoch: corpusIndexProjectionStates.desiredEpoch,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, first.id))
  ).at(0);

  expect(failed).toMatchObject({
    type: "stored",
    corpusWriteFailed: true,
  });
  expect(erased).toEqual({ action: "erase", epoch: 2n });
  expect(retried).toMatchObject({
    type: "stored",
    corpusWriteFailed: false,
  });
  expect(restored).toEqual({ action: "upsert", epoch: 3n });
});

const withdrawalState = async (documentId: SafeId<"legislationDocument">) =>
  (
    await db
      .select({
        kind: legislationDocuments.expressionKind,
        disposition: legislationDocuments.windowDisposition,
        basis: legislationDocuments.windowDispositionBasis,
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
      .where(eq(legislationDocuments.id, documentId))
  ).at(0);

test("a replay keeps a withdrawn version's stored kind, so its payload revision stays put", async () => {
  const live = { ...input("current"), eli: "eli/cz/sb/2012/92" };
  const replay = { ...live, origin: "stored-raw-replay" } as const;

  const first = await processLegislationDocument(live, scopedDb, { corpus });
  if (first.type !== "stored") {
    throw new Error(`expected stored legislation, got ${first.type}`);
  }
  // A promulgated text withdrawn next to its consolidation. The replayed
  // input's shape says nothing about the kind, so the kind must come from
  // the row.
  await db
    .update(legislationDocuments)
    .set({
      expressionKind: "promulgated",
      windowDisposition: "withdrawn",
      windowDispositionBasis: "deferred-promulgated",
    })
    .where(eq(legislationDocuments.id, first.id));
  const withdrawn = await withdrawalState(first.id);

  await processLegislationDocument(replay, scopedDb, { corpus });
  const afterReplay = await withdrawalState(first.id);
  const replayedAgain = await processLegislationDocument(replay, scopedDb, {
    corpus,
  });
  const afterSecondReplay = await withdrawalState(first.id);

  expect(afterReplay).toMatchObject({
    kind: "promulgated",
    disposition: "withdrawn",
    basis: "deferred-promulgated",
    payloadRevision: withdrawn?.payloadRevision,
  });
  expect(replayedAgain).toMatchObject({ type: "stored", skipped: true });
  expect(afterSecondReplay).toEqual(afterReplay);
});

test("a withdrawn version erases, a replay of its stored payload keeps it withdrawn, and a live listing restores it", async () => {
  const live = {
    ...input("current"),
    eli: "eli/cz/sb/2012/91",
    origin: "live",
  } as const;
  const replay = { ...live, origin: "stored-raw-replay" } as const;

  const first = await processLegislationDocument(live, scopedDb, { corpus });
  if (first.type !== "stored") {
    throw new Error(`expected stored legislation, got ${first.type}`);
  }
  const listed = await withdrawalState(first.id);
  // The withdrawal itself, as the census writer will record it.
  await db
    .update(legislationDocuments)
    .set({
      windowDisposition: "withdrawn",
      windowDispositionBasis: "publisher-unlisted",
    })
    .where(eq(legislationDocuments.id, first.id));

  const replayed = await processLegislationDocument(replay, scopedDb, {
    corpus,
  });
  const afterReplay = await withdrawalState(first.id);
  const replayedAgain = await processLegislationDocument(replay, scopedDb, {
    corpus,
  });
  const afterSecondReplay = await withdrawalState(first.id);
  const relisted = await processLegislationDocument(live, scopedDb, {
    corpus,
  });
  const restored = await withdrawalState(first.id);
  const relistedAgain = await processLegislationDocument(live, scopedDb, {
    corpus,
  });

  expect(listed).toMatchObject({ disposition: "effective", action: "upsert" });
  // The replay cannot lift the withdrawal; the row's hash now says what the
  // row is, and its projection is erased.
  expect(replayed).toMatchObject({ type: "stored", skipped: false });
  expect(afterReplay).toMatchObject({
    disposition: "withdrawn",
    basis: "publisher-unlisted",
    action: "erase",
    fingerprint: null,
  });
  expect(afterReplay?.sourceHash).not.toBe(listed?.sourceHash);
  // A second replay is a fixed point: nothing is written.
  expect(replayedAgain).toMatchObject({ type: "stored", skipped: true });
  expect(afterSecondReplay).toEqual(afterReplay);
  // A live listing restores the version under its UUID, to the very hash and
  // fingerprint it had before, and is a fixed point in turn.
  expect(relisted).toMatchObject({ id: first.id, skipped: false });
  expect(restored).toMatchObject({
    disposition: "effective",
    basis: null,
    action: "upsert",
    sourceHash: listed?.sourceHash,
    fingerprint: listed?.fingerprint,
  });
  expect(relistedAgain).toMatchObject({ id: first.id, skipped: true });
});
