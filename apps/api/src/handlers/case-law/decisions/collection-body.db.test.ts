import { panic } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import { databaseRelations } from "@/api/db/database-relations";
import {
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawHeldDecisionAttachments,
  caseLawSources,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { createSafeId } from "@/api/lib/branded-types";
import {
  caseLawPublicReadDb,
  type CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { withRedistributableSubject } from "@/api/lib/case-law/public-subject";
import { HELD_DECISION_MATCH_BASIS } from "@/api/lib/legal-search/held-decision-attachment-values";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  RAW_SOURCE_FAMILY,
  rawDocumentPayloadKey,
} from "@/api/lib/legal-search/raw-source-storage";
import {
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/lib/legal-search/source-raw-envelope";
import { DECISION_READER_TOOL_SET } from "@/api/mcp/decision-reader-tools";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

import { readDecisionHandler } from "./get";
import {
  projectDecisionReader,
  readDecisionSuccessResponseSchema,
} from "./read-response";
import { readDecisionReaderSource, type ReaderSourceOptions } from "./reader";

const sourceId = createSafeId<"caseLawSource">();
const collectionSourceId = createSafeId<"caseLawSource">();
const decisionId = createSafeId<"caseLawDecision">();
const observedAt = "2026-10-09T12:00:00.000Z";
const collectionText = "The official collection supplies the court's reasons.";
const hostText = "The host's later complete decision takes precedence.";
const detail = `<table class="content-table"><tr><td></td><td><h2 class="detail-section__table-heading">Sbírkový text rozhodnutí</h2><p>${collectionText}</p></td></tr></table>`;
const envelope = encodeSourceRawEnvelope({ detail });
const key = rawDocumentPayloadKey(
  { family: RAW_SOURCE_FAMILY.CASE_LAW, sourceId, documentId: decisionId },
  sha256Hex(envelope),
);
let client: Awaited<ReturnType<typeof createTestPglite>>;
let store: ReturnType<typeof startFakeS3>;
let fixture: Awaited<ReturnType<typeof createFixture>>;
const createFixture = (
  databaseClient: Awaited<ReturnType<typeof createTestPglite>>,
) => ({
  db: drizzle({ client: databaseClient, relations: databaseRelations }),
});
const readPublic = async <T>(
  read: (tx: CaseLawPublicReadTransaction) => Promise<T>,
) =>
  await withPublicLawReaderRole(
    fixture.db,
    async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
  );
const caseLawDb = Object.assign(readPublic, caseLawPublicReadDb);
const readApi = async () => {
  const read = await withRedistributableSubject(
    caseLawDb,
    "pages",
    { kind: "id", id: decisionId },
    async (subject) => await readDecisionHandler({ subject }),
  );
  if (read === null || !("bodySource" in read)) {
    return panic("Expected visible decision");
  }
  expect(
    v.safeParse(readDecisionSuccessResponseSchema, projectDecisionReader(read))
      .success,
  ).toBe(true);
  return read;
};
const blocks = async () =>
  await DECISION_READER_TOOL_SET.handlers.read_case_law_decision_blocks({
    args: { decision_id: decisionId },
    context: asTestRaw<AuthorizedMcpRequestContext>({
      testDependencies: {
        readDecisionReaderSource: async (options: ReaderSourceOptions) =>
          await readDecisionReaderSource({ ...options, caseLawDb }),
      },
    }),
  });

// timeout: constructing the embedded database and its role policies is bounded setup, not a request wait.
beforeAll(async () => {
  client = await createTestPglite();
  fixture = createFixture(client);
  store = startFakeS3();
  await fixture.db.insert(caseLawSources).values([
    caseLawSourceRow({ id: sourceId, adapterKey: ADAPTER_KEYS.CZ_NS }),
    caseLawSourceRow({
      id: collectionSourceId,
      adapterKey: ADAPTER_KEYS.CZ_NS_SBIRKA,
    }),
  ]);
  await fixture.db.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId,
    caseNumber: "1 Cdo 1/2026",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
    fulltext: "",
  });
}, 120_000);
afterAll(async () => {
  store?.stop();
  await client?.close();
});

test("public API and MCP blocks share attachment-to-host body selection and provenance", async () => {
  expect((await readApi()).bodySource).toEqual({ textSource: "host" });
  expect(JSON.stringify(await blocks())).not.toContain(collectionText);
  store.put(envBase.S3_BUCKET, key, envelope, SOURCE_RAW_ENVELOPE_CONTENT_TYPE);
  await fixture.db.insert(caseLawHeldDecisionAttachments).values({
    sourceId: collectionSourceId,
    sourceDocumentId: "123",
    hostDecisionId: decisionId,
    matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
    sourceUrl: "https://sbirka.nsoud.cz/sbirka/123/",
    sourceHash: sha256Hex(envelope),
    sourceRawS3Key: key,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    observedAt: new Date(observedAt),
    observationOrder: 1n,
  });
  const collected = await readApi();
  expect(collected.fulltext).toContain(collectionText);
  expect(collected.documentAst).toHaveProperty("blocks");
  expect(collected.bodySource).toMatchObject({
    textSource: "collection",
    retrievedAt: observedAt,
  });
  const selected = JSON.stringify(await blocks());
  expect(selected).toContain(collectionText);
  expect(selected).toContain('"textSource":"collection"');
  await fixture.db
    .update(caseLawDecisions)
    .set({ fulltext: hostText })
    .where(eq(caseLawDecisions.id, decisionId));
  const before = store.requests.length;
  expect((await readApi()).bodySource).toEqual({ textSource: "host" });
  const replaced = JSON.stringify(await blocks());
  expect(replaced).toContain(hostText);
  expect(replaced).not.toContain(collectionText);
  expect(store.requests.length).toBe(before);
  // An unreadable stored object is not an empty publisher response.
  await fixture.db
    .update(caseLawDecisions)
    .set({ fulltext: "" })
    .where(eq(caseLawDecisions.id, decisionId));
  store.objects.delete(`${envBase.S3_BUCKET}/${key}`);
  const failed = await readApi();
  expect(failed.documentReadFailed).toBe(true);
  expect(failed.documentUnavailable).toBe(false);
  store.put(envBase.S3_BUCKET, key, envelope, SOURCE_RAW_ENVELOPE_CONTENT_TYPE);
  await fixture.db
    .update(caseLawSources)
    .set({
      descriptor: {
        license: "permitted-redistribution",
        attribution: null,
        allowsRedistribution: true,
        allowsDerivedAi: false,
      },
    })
    .where(eq(caseLawSources.id, collectionSourceId));
  expect((await readApi()).source.allowsDerivedAi).toBe(true);
  const denied = JSON.stringify(await blocks());
  expect(denied).toContain('"withheld"');
  expect(denied).not.toContain(collectionText);

  const retiredId = createSafeId<"caseLawDecision">();
  const retiredKey = rawDocumentPayloadKey(
    { family: RAW_SOURCE_FAMILY.CASE_LAW, sourceId, documentId: retiredId },
    sha256Hex(envelope),
  );
  await fixture.db
    .insert(caseLawDecisionAliases)
    .values({ retiredDecisionId: retiredId, canonicalDecisionId: decisionId });
  await fixture.db
    .update(caseLawHeldDecisionAttachments)
    .set({ hostDecisionId: retiredId, sourceRawS3Key: retiredKey })
    .where(eq(caseLawHeldDecisionAttachments.sourceId, collectionSourceId));
  store.put(
    envBase.S3_BUCKET,
    retiredKey,
    envelope,
    SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  );
  expect((await readApi()).fulltext).toContain(collectionText);

  const requestsBeforeForeignKey = store.requests.length;
  await fixture.db
    .update(caseLawHeldDecisionAttachments)
    .set({ sourceRawS3Key: key })
    .where(eq(caseLawHeldDecisionAttachments.sourceId, collectionSourceId));
  expect((await readApi()).documentReadFailed).toBe(true);
  expect(store.requests.length).toBe(requestsBeforeForeignKey);
  await fixture.db
    .update(caseLawHeldDecisionAttachments)
    .set({
      sourceRawS3Key: null,
      metadata: null,
      hostWithdrawnAt: new Date(observedAt),
    })
    .where(eq(caseLawHeldDecisionAttachments.sourceId, collectionSourceId));
  const withdrawn = await readApi();
  expect(withdrawn.bodySource).toEqual({ textSource: "host" });
  expect(withdrawn.fulltext).not.toContain(collectionText);
});
