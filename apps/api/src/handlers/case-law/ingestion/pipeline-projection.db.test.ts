import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
  relations,
} from "@/api/db/schema";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import {
  processDecision,
  type CaseLawCorpusDependencies,
} from "@/api/handlers/case-law/ingestion/pipeline";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const sourceId = createSafeId<"caseLawSource">();

const corpusWrite: CaseLawCorpusDependencies["write"] = async (input) => {
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
  mode: "canonical",
  write: corpusWrite,
} satisfies CaseLawCorpusDependencies;

const input = (court: string, rawHash: string): IngestionResult => ({
  caseNumber: "4 As 3/2008",
  court,
  country: "CZE",
  language: "cs",
  decisionDate: "2008-12-18",
  decisionType: "rozsudek",
  fulltext: "Nejvyšší správní soud rozhodl v právní věci žalobkyně.",
  metadata: {},
  rawHash,
  documentAst: {},
});

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));

  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "projection-ingestion-test",
    name: "Projection ingestion test",
  });
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: "case_law_v5",
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
});

afterAll(async () => {
  await client.close();
});

test("a settled case-law write advances desired state and dedup replay repairs to a fixed point", async () => {
  await processDecision({
    input: input("Nejvyšší správní soud", "publisher-v1"),
    observationOrder: 1n,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-08-31T12:00:00.000Z"),
    corpus,
  });
  const decision = (
    await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          eq(caseLawDecisions.caseNumber, "4 As 3/2008"),
        ),
      )
  ).at(0);
  if (decision === undefined) {
    throw new Error("expected stored case-law decision");
  }
  const initialState = (
    await db
      .select({
        epoch: corpusIndexProjectionStates.desiredEpoch,
        fingerprint: corpusIndexProjectionStates.desiredFingerprint,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, decision.id))
  ).at(0);

  const refreshed = input("Ústavní soud", "publisher-v2");
  await processDecision({
    input: refreshed,
    observationOrder: 2n,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-08-31T12:00:01.000Z"),
    corpus,
  });
  const refreshedState = (
    await db
      .select({
        epoch: corpusIndexProjectionStates.desiredEpoch,
        fingerprint: corpusIndexProjectionStates.desiredFingerprint,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, decision.id))
  ).at(0);

  await processDecision({
    input: refreshed,
    observationOrder: 3n,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-08-31T12:00:02.000Z"),
    corpus,
  });
  const replay = (
    await db
      .select({
        court: caseLawDecisions.court,
        epoch: caseLawDecisions.projectionEpoch,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decision.id))
  ).at(0);

  expect(initialState?.epoch).toBe(1n);
  expect(initialState?.fingerprint).not.toBeNull();
  expect(refreshedState?.epoch).toBe(2n);
  expect(refreshedState?.fingerprint).not.toBe(initialState?.fingerprint);
  expect(replay).toEqual({ court: "Ústavní soud", epoch: 2n });
});
