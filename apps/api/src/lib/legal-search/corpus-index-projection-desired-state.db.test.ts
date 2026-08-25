import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  advanceCorpusProjectionDesiredStateTx,
  ensureCorpusProjectionDesiredStateTx,
  reconcileCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const CASE_LAW_SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000101",
);
const CASE_LAW_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000102",
);
const LEGISLATION_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000103",
);
const LEGISLATION_DOCUMENT_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000104",
);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

beforeEach(async () => {
  await db.delete(corpusIndexProjectionStates).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(legislationDocuments).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.delete(legislationSources).where(sql`true`);
  await db.delete(corpusIndexGenerations).where(sql`true`);

  await db.insert(caseLawSources).values({
    id: CASE_LAW_SOURCE_ID,
    adapterKey: "projection-desired-state",
    name: "Projection desired state",
  });
  await db.insert(caseLawDecisions).values({
    id: CASE_LAW_DECISION_ID,
    sourceId: CASE_LAW_SOURCE_ID,
    caseNumber: "4 As 3/2008",
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
    contentHash: "a".repeat(64),
  });
  await db.insert(legislationSources).values({
    id: LEGISLATION_SOURCE_ID,
    adapterKey: "projection-desired-state",
    name: "Projection desired state",
  });
  await db.insert(legislationDocuments).values({
    id: LEGISLATION_DOCUMENT_ID,
    sourceId: LEGISLATION_SOURCE_ID,
    eli: "eli/cz/sb/2012/89",
    title: "Občanský zákoník",
    country: "CZE",
    language: "cs",
    contentHash: "b".repeat(64),
  });
  await db.insert(corpusIndexGenerations).values([
    {
      family: "case_law",
      generation: "case_law_v5",
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.case_law_v5,
      ),
      status: "building",
    },
    {
      family: "legislation",
      generation: "legislation_v2",
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.legislation_v2,
      ),
      status: "building",
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

test("generation bootstrap is idempotent and does not advance another generation", async () => {
  const subject = {
    family: "case_law",
    entityId: CASE_LAW_DECISION_ID,
  } as const;
  const first = await db.transaction(
    async (tx) =>
      await ensureCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        subject,
        "case_law_v5",
      ),
  );
  const second = await db.transaction(
    async (tx) =>
      await ensureCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        subject,
        "case_law_v5",
      ),
  );

  expect(first).toEqual({ created: true, epoch: 1n });
  expect(second).toEqual({ created: false, epoch: 1n });
  expect(
    await db
      .select({ epoch: caseLawDecisions.projectionEpoch })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, CASE_LAW_DECISION_ID)),
  ).toEqual([{ epoch: 1n }]);
});

test("one canonical mutation advances every active family generation once", async () => {
  const subject = {
    family: "case_law",
    entityId: CASE_LAW_DECISION_ID,
  } as const;
  const first = await db.transaction(
    async (tx) =>
      await ensureCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        subject,
        "case_law_v5",
      ),
  );
  const before = await db
    .select({ fingerprint: corpusIndexProjectionStates.desiredFingerprint })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, CASE_LAW_DECISION_ID));
  await db
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: "blocked",
      lastFailureKind: "revision_too_large",
      lastFailureMessage: "projection revision exceeds the safety ceiling",
    })
    .where(eq(corpusIndexProjectionStates.entityId, CASE_LAW_DECISION_ID));

  const advanced = await db.transaction(async (tx) => {
    await tx
      .update(caseLawDecisions)
      .set({ court: "Ústavní soud" })
      .where(eq(caseLawDecisions.id, CASE_LAW_DECISION_ID));
    return await advanceCorpusProjectionDesiredStateTx(
      asTestRaw<Transaction>(tx),
      subject,
    );
  });
  const after = await db
    .select({
      epoch: corpusIndexProjectionStates.desiredEpoch,
      fingerprint: corpusIndexProjectionStates.desiredFingerprint,
      indexId: corpusIndexProjectionStates.desiredIndexId,
      workStatus: corpusIndexProjectionStates.workStatus,
      retryNotBefore: corpusIndexProjectionStates.retryNotBefore,
      lastFailureKind: corpusIndexProjectionStates.lastFailureKind,
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, CASE_LAW_DECISION_ID));

  expect(first.epoch).toBe(1n);
  expect(advanced).toEqual({ epoch: 2n, generationCount: 1 });
  expect(after).toMatchObject([
    {
      epoch: 2n,
      indexId: "case_law_v5_cs_sk",
      workStatus: "eligible",
      retryNotBefore: null,
      lastFailureKind: null,
    },
  ]);
  expect(after.at(0)?.fingerprint).not.toBe(before.at(0)?.fingerprint);
});

test("redistribution revocation becomes an erase desired state", async () => {
  const subject = {
    family: "legislation",
    entityId: LEGISLATION_DOCUMENT_ID,
  } as const;
  await db.transaction(
    async (tx) =>
      await ensureCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        subject,
        "legislation_v2",
      ),
  );
  await db.transaction(async (tx) => {
    await tx
      .update(legislationSources)
      .set({
        descriptor: {
          license: "restricted",
          attribution: null,
          allowsRedistribution: false,
          allowsDerivedAi: false,
        },
      })
      .where(eq(legislationSources.id, LEGISLATION_SOURCE_ID));
    await advanceCorpusProjectionDesiredStateTx(
      asTestRaw<Transaction>(tx),
      subject,
    );
  });

  expect(
    await db
      .select({
        action: corpusIndexProjectionStates.desiredAction,
        epoch: corpusIndexProjectionStates.desiredEpoch,
        fingerprint: corpusIndexProjectionStates.desiredFingerprint,
        indexId: corpusIndexProjectionStates.desiredIndexId,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, LEGISLATION_DOCUMENT_ID)),
  ).toEqual([{ action: "erase", epoch: 2n, fingerprint: null, indexId: null }]);
});

test("bounded reconciliation repairs drift once and then reaches a fixed point", async () => {
  const subject = {
    family: "legislation",
    entityId: LEGISLATION_DOCUMENT_ID,
  } as const;
  await db.transaction(
    async (tx) =>
      await ensureCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        subject,
        "legislation_v2",
      ),
  );
  await db
    .update(legislationDocuments)
    .set({ title: "Nový občanský zákoník" })
    .where(eq(legislationDocuments.id, LEGISLATION_DOCUMENT_ID));

  const repaired = await db.transaction(
    async (tx) =>
      await reconcileCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        subject,
      ),
  );
  const fixedPoint = await db.transaction(
    async (tx) =>
      await reconcileCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        subject,
      ),
  );

  expect(repaired).toEqual({
    epoch: 2n,
    changed: true,
    generationCount: 1,
  });
  expect(fixedPoint).toEqual({
    epoch: 2n,
    changed: false,
    generationCount: 1,
  });
});
