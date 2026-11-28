import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@stll/case-law-ingestion-core/decision-text";
import { plainTextIngestionResult } from "@stll/case-law-ingestion-core/plain-text-assembly";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { decisionRecoveryRowFingerprint } from "@/api/handlers/case-law/ingestion/pipeline/recovery-fence";
import { createSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import { processDecision, processRecoveredDecision } from "./decision";
import type { CaseLawCorpusDependencies } from "./dependencies";
import { PROCESS_DECISION_STATUS } from "./outcomes";
import { DECISION_REFRESH } from "./types";
import type { DecisionRecoveryFence } from "./types";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
const sourceId = createSafeId<"caseLawSource">();
const corpus = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError("inline test must not transfer");
    },
  },
} satisfies CaseLawCorpusDependencies;
const input = (documentId: string, fulltext: string) =>
  plainTextIngestionResult({
    sourceDocumentId: documentId,
    caseNumber: `5 As ${documentId}/2026`,
    court: "Nejvyšší správní soud",
    country: "CZE",
    language: "cs",
    fulltext,
    rawHash: fulltext || "empty",
    documentAst: {
      version: 1,
      source: { system: "test", documentId, webUrl: "", printUrl: "" },
      metadata: {
        caseNumber: null,
        ecli: null,
        court: null,
        decisionDate: null,
        decisionType: null,
        keywords: [],
        statutes: [],
      },
      blocks: [],
    },
    metadata: { publisherField: "retained" },
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
  });
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: "decision-fence-test",
    name: "Decision fence test",
  });
});
afterAll(async () => {
  await client.close();
});
const readFence = async (
  documentId: string,
): Promise<DecisionRecoveryFence> => {
  const row = (
    await db
      .select({
        id: caseLawDecisions.id,
        sourceHash: caseLawDecisions.sourceHash,
        sourceHashVersion: caseLawDecisions.sourceHashVersion,
        sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        sourceObservationOrder: caseLawDecisions.sourceObservationOrder,
        rowFingerprint: decisionRecoveryRowFingerprint(),
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceDocumentId, documentId))
  ).at(0);
  if (row === undefined) {
    throw new TypeError("fixture row required");
  }
  return {
    decisionId: row.id,
    sourceDocumentId: documentId,
    sourceHash: row.sourceHash,
    sourceHashVersion: row.sourceHashVersion,
    sourceRawS3Key: row.sourceRawS3Key,
    sourceObservationOrder: row.sourceObservationOrder,
    rowFingerprint: row.rowFingerprint,
  };
};
const seed = async (documentId: string) => {
  const result = (
    await processDecision({
      input: input(documentId, ""),
      sourceId,
      scopedDb,
      observedAt: new Date("2026-01-01"),
      observationOrder: 1n,
      refresh: DECISION_REFRESH.ALWAYS,
      corpus,
    })
  ).unwrap();
  expect(result.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  await db
    .update(caseLawDecisions)
    .set({ metadata: { publisherField: "retained" } })
    .where(eq(caseLawDecisions.sourceDocumentId, documentId));
  return await readFence(documentId);
};
const recover = async (fence: DecisionRecoveryFence) =>
  (
    await processRecoveredDecision({
      input: input(
        fence.sourceDocumentId,
        "Rozhodnutí soudu obsahuje ověřený text.",
      ),
      sourceId,
      scopedDb,
      observedAt: new Date("2026-01-02"),
      observationOrder: 2n,
      fence,
      corpus,
    })
  ).unwrap();
test("canonical recovery writes precisely the captured observation", async () => {
  const fence = await seed("101");
  expect((await recover(fence)).status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  const row = (
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, fence.decisionId))
  ).at(0);
  expect(row?.fulltext).toContain("ověřený text");
});
test("atomic canonical fence refuses changed publisher metadata", async () => {
  const fence = await seed("102");
  await db
    .update(caseLawDecisions)
    .set({ metadata: { publisherField: "new observation" } })
    .where(eq(caseLawDecisions.id, fence.decisionId));
  expect((await recover(fence)).status).toBe(PROCESS_DECISION_STATUS.RETRYABLE);
  const row = (
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, fence.decisionId))
  ).at(0);
  expect(row?.fulltext ?? "").toBe("");
  expect(row?.metadata?.["publisherField"]).toBe("new observation");
});

test("atomic canonical fence preserves a concurrent body repair with the same source observation", async () => {
  const fence = await seed("103");
  await db
    .update(caseLawDecisions)
    .set({ fulltext: "Document supplied by a concurrent canonical repair" })
    .where(eq(caseLawDecisions.id, fence.decisionId));
  expect((await recover(fence)).status).toBe(PROCESS_DECISION_STATUS.RETRYABLE);
  const row = (
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, fence.decisionId))
  ).at(0);
  expect(row?.fulltext).toBe(
    "Document supplied by a concurrent canonical repair",
  );
});

test("canonical recovery cannot publish a row excluded by the publication owner", async () => {
  const previous = await seed("104");
  await db
    .update(caseLawDecisions)
    .set({ metadata: { _stellaPartialObservation: { isListingOnly: true } } })
    .where(eq(caseLawDecisions.id, previous.decisionId));
  const fence = await readFence("104");
  expect((await recover(fence)).status).toBe(PROCESS_DECISION_STATUS.RETRYABLE);
  const row = (
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, fence.decisionId))
  ).at(0);
  expect(row?.fulltext ?? "").toBe("");
});
