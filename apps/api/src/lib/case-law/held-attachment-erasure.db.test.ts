import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { propertyTestTimeout } from "@stll/property-testing";
import { sha256Hex } from "@stll/sha256/bun";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  caseLawDecisions,
  caseLawHeldDecisionAttachments,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { legacyTrustedUsaCourts } from "@/api/lib/case-law/decision-court-identity";
import { parkAttachmentsOfErasedDecisionTx } from "@/api/lib/case-law/held-attachment-erasure";
import { lockCaseLawDecisionRows } from "@/api/lib/db/aggregate-lock";
import { encodeCollectionDocumentBody } from "@/api/lib/legal-search/collection-document-part";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import { HELD_DECISION_MATCH_BASIS } from "@/api/lib/legal-search/held-decision-attachment-values";
import {
  RAW_SOURCE_FAMILY,
  rawSourcePayloadKey,
} from "@/api/lib/legal-search/raw-source-storage";
import {
  createIngestionRoleScopedDb,
  createTestPglite,
} from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client, relations: { ...relations, ...authRelationsPart } });
}, propertyTestTimeout(120_000));
afterAll(async () => await client.close());

test("erasure clears collection bodies and identity evidence and replays without changes", async () => {
  const sourceId = createSafeId<"caseLawSource">();
  const collectionId = createSafeId<"caseLawSource">();
  const decisionId = createSafeId<"caseLawDecision">();
  const court = legacyTrustedUsaCourts().at(0) ?? panic("Fixture court absent");
  await db.insert(caseLawSources).values(
    [sourceId, collectionId].map((id) => ({
      id,
      adapterKey: `snapshot-erasure-${id}`,
      name: "Collection erasure fixture",
    })),
  );
  await db.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId,
    sourceDocumentId: "host",
    country: "USA",
    language: "en",
    court: court.name,
    courtId: court.courtId,
    caseNumber: "24-1",
    decisionDate: "2024-01-01",
    documentAst: EMPTY_AST,
  });
  const bytes = encodeCollectionDocumentBody({
    text: "Retained collection body.",
    sections: null,
    ast: EMPTY_AST,
  }).unwrap();
  const key = rawSourcePayloadKey({
    owner: {
      family: RAW_SOURCE_FAMILY.CASE_LAW,
      sourceId,
      documentId: decisionId,
    },
    data: bytes,
  });
  await db.insert(caseLawHeldDecisionAttachments).values({
    sourceId: collectionId,
    sourceDocumentId: "part",
    hostDecisionId: decisionId,
    matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
    matchEvidence: {
      status: "matched",
      basis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
      ecliDiscrepancy: null,
    },
    metadata: { legalSentence: "Retained publisher headnote." },
    documentPart: {
      extent: "unclassified",
      legalSentence: "Retained publisher headnote.",
      keywords: [],
    },
    documentBodyS3Key: key,
    documentBodySha256: sha256Hex(bytes),
    observedAt: new Date("2026-01-01T00:00:00Z"),
    observationOrder: 1n,
    sourceHash: "fixture-observation",
  });
  const scopedDb = createIngestionRoleScopedDb(db);
  const erase = async () =>
    await scopedDb(async (tx) => {
      await lockCaseLawDecisionRows({ tx, decisionIds: [decisionId] });
      await parkAttachmentsOfErasedDecisionTx(tx, decisionId);
    });
  const read = () =>
    db
      .select()
      .from(caseLawHeldDecisionAttachments)
      .where(eq(caseLawHeldDecisionAttachments.sourceId, collectionId));
  await erase();
  const erased = await read();
  expect(erased.at(0)).toMatchObject({
    metadata: null,
    documentPart: null,
    documentBodyS3Key: null,
    documentBodySha256: null,
    matchEvidence: null,
  });
  expect(erased.at(0)?.hostWithdrawnAt).toBeInstanceOf(Date);
  await erase();
  expect(await read()).toEqual(erased);
});
