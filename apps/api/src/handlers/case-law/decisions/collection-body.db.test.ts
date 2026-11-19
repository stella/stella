import { panic, Result } from "better-result";
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
import {
  COLLECTION_DOCUMENT_BODY_CONTENT_TYPE,
  encodeCollectionDocumentBody,
} from "@/api/lib/legal-search/collection-document-part";
import type { CollectionDocumentPart } from "@/api/lib/legal-search/collection-document-part";
import type { CorpusPayload } from "@/api/lib/legal-search/corpus-content-hash";
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

import {
  COLLECTION_EMPTY_EVIDENCE_KIND,
  readCollectionBody,
} from "./collection-body";
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
const envelope = encodeSourceRawEnvelope({
  listing: JSON.stringify({ postId: "123" }),
  detail,
});
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
const readApi = async (id = decisionId) => {
  const read = await withRedistributableSubject(
    caseLawDb,
    "pages",
    { kind: "id", id },
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
const blocks = async (id = decisionId) =>
  await DECISION_READER_TOOL_SET.handlers.read_case_law_decision_blocks({
    args: { decision_id: id },
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
  store.stop();
  await client.close();
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
  expect(JSON.stringify(await blocks())).toContain(collectionText);
  const denied = await readDecisionReaderSource({
    caseLawDb,
    decisionId,
    phase: "blocks",
    audience: "model",
    surface: "search",
  });
  expect(denied?.status).toBe("read");
  if (denied?.status !== "read") {
    panic("Expected visible collection reader source");
  }
  expect(denied.textAccess).toBe("withheld");
  expect(denied.ast).toBeNull();

  const retiredId = createSafeId<"caseLawDecision">();
  const retiredKey = rawDocumentPayloadKey(
    { family: RAW_SOURCE_FAMILY.CASE_LAW, sourceId, documentId: retiredId },
    sha256Hex(envelope),
  );
  await fixture.db.insert(caseLawDecisions).values({
    id: retiredId,
    sourceId,
    caseNumber: "1 Cdo 2/2026",
    court: "Nejvyšší soud",
    country: "CZE",
    language: "cs",
  });
  await fixture.db
    .insert(caseLawDecisionAliases)
    .values({ retiredDecisionId: retiredId, canonicalDecisionId: decisionId });
  await fixture.db
    .delete(caseLawDecisions)
    .where(eq(caseLawDecisions.id, retiredId));
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

  const wrongEntry = encodeSourceRawEnvelope({
    listing: JSON.stringify({ postId: "456" }),
    detail,
  });
  const wrongEntryKey = rawDocumentPayloadKey(
    { family: RAW_SOURCE_FAMILY.CASE_LAW, sourceId, documentId: retiredId },
    sha256Hex(wrongEntry),
  );
  store.put(
    envBase.S3_BUCKET,
    wrongEntryKey,
    wrongEntry,
    SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  );
  await fixture.db
    .update(caseLawHeldDecisionAttachments)
    .set({ sourceRawS3Key: wrongEntryKey })
    .where(eq(caseLawHeldDecisionAttachments.sourceId, collectionSourceId));
  expect((await readApi()).documentReadFailed).toBe(true);

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

test("retained Polish publication parts compose through public readers and yield to a later host body", async () => {
  const ownId = createSafeId<"caseLawDecision">();
  const canonicalId = createSafeId<"caseLawDecision">();
  const collectionId = createSafeId<"caseLawSource">();
  await fixture.db
    .insert(caseLawSources)
    .values(
      caseLawSourceRow({
        id: collectionId,
        adapterKey: ADAPTER_KEYS.PL_COURTS,
      }),
    );
  const identity = {
    caseNumber: "III CZP 1/2025",
    court: "Sąd Najwyższy",
    decisionDate: "2025-01-02",
    ecli: null,
    decisionType: "decision",
  };
  const payload = (postId: string, texts: readonly string[]) =>
    ({
      text: texts.join("\n\n"),
      sections: [],
      ast: {
        version: 1,
        source: {
          system: "pl-courts",
          documentId: postId,
          webUrl: `https://example.test/collection/${postId}`,
          printUrl: "",
        },
        metadata: { ...identity, keywords: [], statutes: [] },
        blocks: texts.map((text, index) => ({
          type: "paragraph",
          id: `block-${index}`,
          anchorId: `block-${index}`,
          plainText: text,
          inlines: [{ type: "text", text }],
        })),
      },
    }) satisfies CorpusPayload;
  const firstTexts = ["Common opening", "Section one", "Common closing"];
  await fixture.db.insert(caseLawDecisions).values({
    id: ownId,
    sourceId: collectionId,
    sourceDocumentId: "part-1",
    ...identity,
    country: "POL",
    language: "pl",
    sourceUrl: "https://example.test/collection/part-1",
    sourceObservedAt: new Date(observedAt),
    documentAst: payload("part-1", firstTexts).ast,
    fulltext: firstTexts.join("\n\n"),
  });
  const retain = async (
    postId: string,
    documentPart: CollectionDocumentPart,
    texts: readonly string[],
  ) => {
    const encoded = encodeCollectionDocumentBody(payload(postId, texts));
    if (Result.isError(encoded)) {
      return panic("Expected bounded collection fixture");
    }
    const hash = sha256Hex(encoded.value);
    const bodyKey = rawDocumentPayloadKey(
      {
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        sourceId: collectionId,
        documentId: ownId,
      },
      hash,
    );
    store.put(
      envBase.S3_BUCKET,
      bodyKey,
      encoded.value,
      COLLECTION_DOCUMENT_BODY_CONTENT_TYPE,
    );
    await fixture.db.insert(caseLawHeldDecisionAttachments).values({
      sourceId: collectionId,
      sourceDocumentId: postId,
      hostDecisionId: ownId,
      matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
      matchEvidence: {
        status: "matched",
        basis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
        ecliDiscrepancy: null,
      },
      documentPart,
      documentBodyS3Key: bodyKey,
      documentBodySha256: hash,
      sourceUrl: `https://example.test/collection/${postId}`,
      sourceHash: hash,
      observedAt: new Date(observedAt),
      observationOrder: 1n,
    });
    return bodyKey;
  };
  const part = (sectionNumber: number) =>
    ({
      extent: "section",
      sectionNumber,
      firstBlock: 1,
      afterLastBlock: 2,
      collectionLabel: "Printed collection",
      legalSentence: null,
      keywords: [],
    }) satisfies CollectionDocumentPart;
  await retain("part-1", part(1), firstTexts);
  await retain("part-2", part(2), [
    "Common opening",
    "Section two",
    "Common closing",
  ]);
  const composed = await readApi(ownId);
  expect(composed.fulltext).toBe(
    "Common opening\n\nSection one\n\nSection two\n\nCommon closing",
  );
  expect(composed.bodySource).toMatchObject({
    textSource: "collection",
    extent: "section",
    provenance: { totalCount: 2, omittedCount: 0 },
  });
  expect(JSON.stringify(composed.documentAst)).toContain("Section two");
  const publicBlocks = JSON.stringify(await blocks(ownId));
  expect(publicBlocks).toContain("Section one");
  expect(publicBlocks).toContain("Section two");
  expect(publicBlocks).toContain("https://example.test/collection/part-1");
  expect(publicBlocks).toContain("https://example.test/collection/part-2");
  const completeKey = await retain(
    "complete",
    { extent: "complete", legalSentence: null, keywords: [] },
    ["Whole published edition", "Section one", "Section two"],
  );
  const requestsBeforeComplete = store.requests.length;
  const complete = await readApi(ownId);
  expect(complete.bodySource).toMatchObject({
    textSource: "collection",
    extent: "complete",
    sourceUrl: "https://example.test/collection/complete",
    provenance: { totalCount: 3 },
  });
  expect(complete.fulltext).toContain("Whole published edition");
  expect(
    store.requests
      .slice(requestsBeforeComplete)
      .filter(({ key: requestedKey }) => requestedKey === completeKey),
  ).toHaveLength(1);
  await fixture.db.insert(caseLawDecisions).values({
    id: canonicalId,
    sourceId: collectionId,
    sourceDocumentId: "official",
    ...identity,
    country: "POL",
    language: "pl",
    fulltext: "",
  });
  await fixture.db
    .insert(caseLawDecisionAliases)
    .values({ retiredDecisionId: ownId, canonicalDecisionId: canonicalId });
  await fixture.db
    .delete(caseLawDecisions)
    .where(eq(caseLawDecisions.id, ownId));
  expect((await readApi(canonicalId)).fulltext).toContain(
    "Whole published edition",
  );
  const retainedRows = await fixture.db
    .select({
      hostId: caseLawHeldDecisionAttachments.hostDecisionId,
      observedAt: caseLawHeldDecisionAttachments.observedAt,
    })
    .from(caseLawHeldDecisionAttachments)
    .where(eq(caseLawHeldDecisionAttachments.sourceId, collectionId));
  expect(retainedRows).toHaveLength(3);
  expect(
    retainedRows.every(
      (row) =>
        row.hostId === ownId && row.observedAt.toISOString() === observedAt,
    ),
  ).toBe(true);
  await fixture.db
    .update(caseLawDecisions)
    .set({
      fulltext: "Later complete host body",
      updatedAt: new Date("2026-10-10T12:00:00.000Z"),
    })
    .where(eq(caseLawDecisions.id, canonicalId));
  const requestsBeforeHost = store.requests.length;
  const host = await readApi(canonicalId);
  expect(host.bodySource).toEqual({ textSource: "host" });
  expect(host.fulltext).toBe("Later complete host body");
  expect(JSON.stringify(await blocks(canonicalId))).toContain(
    "Later complete host body",
  );
  expect(store.requests.length).toBe(requestsBeforeHost);
  await fixture.db
    .update(caseLawDecisions)
    .set({
      fulltext: null,
      documentUrl: "https://example.test/official/document",
      documentAst: payload("official", ["Later complete host AST"]).ast,
      updatedAt: new Date("2026-10-11T12:00:00.000Z"),
    })
    .where(eq(caseLawDecisions.id, canonicalId));
  const hostAst = await readApi(canonicalId);
  expect(hostAst.documentPending).toBe(false);
  expect(hostAst.documentUnavailable).toBe(false);
  expect(JSON.stringify(hostAst.documentAst)).toContain(
    "Later complete host AST",
  );
  expect(JSON.stringify(await blocks(canonicalId))).toContain(
    "Later complete host AST",
  );
  expect(store.requests.length).toBe(requestsBeforeHost);
});

test("legacy collection-owned rows retain their observed time or explicit unknown extent and time", async () => {
  for (const observation of [new Date(observedAt), null]) {
    const id = createSafeId<"caseLawDecision">();
    await fixture.db.insert(caseLawDecisions).values({
      id,
      sourceId: collectionSourceId,
      sourceDocumentId: `legacy-${id}`,
      caseNumber: `Legacy ${id}`,
      court: "Nejvyšší soud",
      country: "CZE",
      language: "cs",
      sourceUrl: `https://example.test/collection/${id}`,
      sourceObservedAt: observation,
      updatedAt: new Date("2026-10-20T12:00:00.000Z"),
      fulltext: "Retained legacy publication text",
    });
    const encoded = encodeCollectionDocumentBody({
      text: "Unclassified related publication text",
      sections: [],
      ast: null,
    });
    if (Result.isError(encoded)) {
      panic("Expected bounded related fixture");
    }
    const hash = sha256Hex(encoded.value);
    const bodyKey = rawDocumentPayloadKey(
      {
        family: RAW_SOURCE_FAMILY.CASE_LAW,
        sourceId: collectionSourceId,
        documentId: id,
      },
      hash,
    );
    store.put(
      envBase.S3_BUCKET,
      bodyKey,
      encoded.value,
      COLLECTION_DOCUMENT_BODY_CONTENT_TYPE,
    );
    await fixture.db
      .insert(caseLawHeldDecisionAttachments)
      .values({
        sourceId: collectionSourceId,
        sourceDocumentId: `related-${id}`,
        hostDecisionId: id,
        matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
        matchEvidence: {
          status: "matched",
          basis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
          ecliDiscrepancy: null,
        },
        documentPart: {
          extent: "unclassified",
          legalSentence: "Actual related headnote",
          keywords: [],
        },
        documentBodyS3Key: bodyKey,
        documentBodySha256: hash,
        sourceHash: hash,
        sourceUrl: `https://example.test/collection/related-${id}`,
        observedAt: new Date(observedAt),
        observationOrder: 1n,
      });
    const beforeRead = store.requests.length;
    const result = await readApi(id);
    expect(result.fulltext).toBe("Retained legacy publication text");
    expect(store.requests.length).toBe(beforeRead);
    expect(JSON.stringify(result.bodySource)).not.toContain(
      "Actual related headnote",
    );
    expect(result.bodySource).toMatchObject({
      textSource: "collection",
      extent: "unclassified",
      retrievedAt: observation?.toISOString() ?? null,
      provenance: { totalCount: 2 },
    });
    expect(JSON.stringify(result.bodySource)).not.toContain("2026-10-20");
  }
});

test("an empty retained snapshot does not attest an empty publisher page", async () => {
  const id = createSafeId<"caseLawDecision">();
  const postId = `empty-${id}`;
  const identity = {
    caseNumber: "4 Cdo 1/2026",
    court: "Nejvyšší soud",
    ecli: undefined,
    decisionDate: undefined,
    decisionType: undefined,
  };
  await fixture.db
    .insert(caseLawDecisions)
    .values({
      id,
      sourceId,
      country: "CZE",
      language: "cs",
      caseNumber: identity.caseNumber,
      court: identity.court,
      fulltext: "",
    });
  const encoded = encodeCollectionDocumentBody({
    text: "",
    sections: [],
    ast: null,
  });
  if (Result.isError(encoded)) {
    panic("Expected bounded empty fixture");
  }
  const hash = sha256Hex(encoded.value);
  const bodyKey = rawDocumentPayloadKey(
    { family: RAW_SOURCE_FAMILY.CASE_LAW, sourceId, documentId: id },
    hash,
  );
  store.put(
    envBase.S3_BUCKET,
    bodyKey,
    encoded.value,
    COLLECTION_DOCUMENT_BODY_CONTENT_TYPE,
  );
  await fixture.db
    .insert(caseLawHeldDecisionAttachments)
    .values({
      sourceId: collectionSourceId,
      sourceDocumentId: postId,
      hostDecisionId: id,
      matchBasis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
      matchEvidence: {
        status: "matched",
        basis: HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE,
        ecliDiscrepancy: null,
      },
      documentPart: {
        extent: "unclassified",
        legalSentence: null,
        keywords: [],
      },
      documentBodyS3Key: bodyKey,
      documentBodySha256: hash,
      sourceHash: hash,
      sourceUrl: `https://example.test/collection/${postId}`,
      observedAt: new Date(observedAt),
      observationOrder: 1n,
    });
  const snapshot = await readPublic(
    async (tx) => await readCollectionBody({ tx, decisionId: id, identity }),
  );
  expect(snapshot).toMatchObject({
    status: "empty",
    evidence: {
      kind: COLLECTION_EMPTY_EVIDENCE_KIND.SNAPSHOT,
      rawKey: bodyKey,
      rawSha256: hash,
    },
  });
  const emptyPage = encodeSourceRawEnvelope({
    listing: JSON.stringify({ postId }),
    detail:
      '<table class="content-table"><tr><td></td><td><h2 class="detail-section__table-heading">Sbírkový text rozhodnutí</h2></td></tr></table>',
  });
  const rawKey = rawDocumentPayloadKey(
    { family: RAW_SOURCE_FAMILY.CASE_LAW, sourceId, documentId: id },
    sha256Hex(emptyPage),
  );
  store.put(
    envBase.S3_BUCKET,
    rawKey,
    emptyPage,
    SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  );
  await fixture.db
    .update(caseLawHeldDecisionAttachments)
    .set({
      documentPart: null,
      documentBodyS3Key: null,
      documentBodySha256: null,
      sourceRawS3Key: rawKey,
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    })
    .where(eq(caseLawHeldDecisionAttachments.sourceDocumentId, postId));
  const publisher = await readPublic(
    async (tx) => await readCollectionBody({ tx, decisionId: id, identity }),
  );
  expect(publisher).toMatchObject({
    status: "empty",
    evidence: {
      kind: COLLECTION_EMPTY_EVIDENCE_KIND.PUBLISHER_PAGE,
      rawKey,
      rawSha256: sha256Hex(emptyPage),
    },
  });
  await fixture.db
    .update(caseLawHeldDecisionAttachments)
    .set({ matchEvidence: { status: "ambiguous", completeness: "complete" } })
    .where(eq(caseLawHeldDecisionAttachments.sourceDocumentId, postId));
  const beforeParkedRead = store.requests.length;
  const parked = await readPublic(
    async (tx) => await readCollectionBody({ tx, decisionId: id, identity }),
  );
  expect(parked).toEqual({ status: "absent" });
  expect(store.requests.length).toBe(beforeParkedRead);
});
