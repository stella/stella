import { panic, Result } from "better-result";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";
import type { Block, DocumentAst } from "@stll/legal-ast/document-ast";
import { propertyTestTimeout } from "@stll/property-testing";
import { deferred, settledWithin } from "@stll/test-kit";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawDecisionSourceIdentities,
  caseLawHeldDecisionAttachments,
  caseLawIngestionFailureEvidence,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import type { AttachToHeldDecisionOptions } from "@/api/handlers/case-law/ingestion/pipeline/held-decision-attachment";
import { sourceContractForAdapter } from "@/api/handlers/case-law/ingestion/pipeline/source-contract";
import { createSafeId } from "@/api/lib/branded-types";
import { legacyTrustedUsaCourts } from "@/api/lib/case-law/decision-court-identity";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { UNPERSISTABLE_DECISION_FIELDS } from "@/api/lib/errors/tagged-errors";
import {
  type CollectionDocumentPart,
  collectionDocumentPartSchema,
  decodeCollectionDocumentBody,
} from "@/api/lib/legal-search/collection-document-part";
import { EMPTY_AST } from "@/api/lib/legal-search/document-types";
import type { HeldDecisionAttachment } from "@/api/lib/legal-search/held-decision-attachment";
import type { RawIngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
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
const court =
  legacyTrustedUsaCourts().at(0) ?? panic("USA fixture court is absent");
const corpus = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError("Offline fixture must not transfer corpus packs");
    },
  },
} satisfies CaseLawCorpusDependencies;

const fixture = async (index: number) => {
  const source = async () => {
    const id = createSafeId<"caseLawSource">();
    const adapterKey = `split-collection-${id}`;
    await db
      .insert(caseLawSources)
      .values({ id, adapterKey, name: "Split collection fixture" });
    return { id, adapterKey };
  };
  const publisher = await source();
  const collection = await source();
  const metadataSchema = v.object({ part: collectionDocumentPartSchema });
  const declaration = {
    hostAdapterKeys: [publisher.adapterKey],
    metadataKey: "collectionFixture",
    metadataSchema,
    documentPartSchema: v.pipe(
      metadataSchema,
      v.transform(({ part }) => part),
    ),
    declaredIdentifierTypes: [DECISION_IDENTIFIER_TYPES.REPORTER_CITATION],
    docketHeldUnderOtherDate: "park-for-review",
  } as const satisfies HeldDecisionAttachment<string>;
  const objects = new Map<string, Uint8Array>();
  const payloadWriter: AttachToHeldDecisionOptions["rawPayloadWriter"] =
    async ({ result, sourceId, ownerId, onWriteStart }) => {
      const data = result.sourceRawBytes ?? result.sourceRaw;
      if (data === undefined) {
        return Result.ok(undefined);
      }
      const key = rawSourcePayloadKey({
        owner: {
          family: RAW_SOURCE_FAMILY.CASE_LAW,
          sourceId,
          documentId: ownerId,
        },
        data,
      });
      if (!objects.has(key)) {
        onWriteStart?.();
        objects.set(
          key,
          typeof data === "string" ? new TextEncoder().encode(data) : data,
        );
      }
      return Result.ok(key);
    };
  const scopedDb = createIngestionRoleScopedDb(db);
  let order = 0;
  type PartInputOptions = {
    post: string;
    ordinal: number;
    text: string;
    part?: CollectionDocumentPart;
    ecli?: string;
  };
  const input = ({ post, ordinal, text, part, ecli }: PartInputOptions) => {
    const descriptor =
      part ??
      ({
        extent: "section",
        sectionNumber: ordinal,
        firstBlock: 1,
        afterLastBlock: 2,
        collectionLabel: "No. 12",
        legalSentence: null,
        keywords: [`Subject ${ordinal}`],
      } as const satisfies CollectionDocumentPart);
    const blocks = ["Common report prefix", text, "Common report suffix"].map(
      (plainText, n) =>
        ({
          type: "paragraph",
          id: `p${n}`,
          anchorId: `a${n}`,
          number: n + 1,
          plainText,
          inlines: [{ type: "text", text: plainText }],
        }) satisfies Block,
    );
    const documentAst = {
      version: 1,
      source: {
        system: "split-reporter",
        documentId: post,
        webUrl: `https://example.test/${post}`,
        printUrl: `https://example.test/${post}`,
      },
      metadata: {
        caseNumber: `24-${index}`,
        ecli: ecli ?? null,
        court: court.name,
        decisionDate: "2024-01-01",
        decisionType: "Judgment",
        keywords: [],
        statutes: [],
      },
      blocks,
    } satisfies DocumentAst;
    return {
      country: "USA",
      language: "en",
      court: court.name,
      courtId: court.courtId,
      caseNumber: `24-${index}`,
      decisionDate: "2024-01-01",
      sourceDocumentId: post,
      sourceUrl: `https://example.test/${post}`,
      documentAst,
      fulltext: blocks.map(({ plainText }) => plainText).join("\n"),
      rawHash: `${post}:${text}`,
      metadata: { collectionFixture: { part: descriptor } },
      ...(ecli === undefined ? {} : { ecli }),
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    } satisfies RawIngestionResult;
  };
  const ingestOutcome = async (
    item: RawIngestionResult,
    role: "collection" | "publisher" = "collection",
    options: {
      scopedDb?: ScopedDb;
      writer?: AttachToHeldDecisionOptions["rawPayloadWriter"];
    } = {},
  ) => {
    order += 1;
    const producer = role === "collection" ? collection : publisher;
    const contract = {
      ...sourceContractForAdapter(producer.adapterKey),
      heldDecisionAttachment: role === "collection" ? declaration : null,
    };
    return await processDecision(
      {
        input: plainTextIngestionResult(item),
        sourceId: producer.id,
        scopedDb: options.scopedDb ?? scopedDb,
        observedAt: new Date(Date.UTC(2026, 10, 19, 10, 0, order)),
        observationOrder: BigInt(order),
        corpus,
        heldDecisionPayloadWriter: options.writer ?? payloadWriter,
      },
      async () => await Promise.resolve(contract),
    );
  };
  const ingest = async (...args: Parameters<typeof ingestOutcome>) =>
    (await ingestOutcome(...args)).unwrap();
  const rows = async () =>
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, collection.id));
  const parts = async () =>
    await db
      .select()
      .from(caseLawHeldDecisionAttachments)
      .where(eq(caseLawHeldDecisionAttachments.sourceId, collection.id));
  return {
    publisher,
    collection,
    ingestOutcome,
    declaration,
    scopedDb,
    objects,
    input,
    ingest,
    rows,
    parts,
  };
};

test("a non-Czech own-first report retains distinct posts without inventing reporter citations", async () => {
  const f = await fixture(11);
  expect(
    (
      await f.ingest(
        f.input({ post: "first", ordinal: 1, text: "First section" }),
      )
    ).status,
  ).toBe("complete");
  const own = (await f.rows()).at(0) ?? panic("Own report was not inserted");
  const self =
    (await f.parts()).at(0) ?? panic("Self-part was not persisted atomically");
  expect(self.hostDecisionId).toBe(own.id);
  expect(self.sourceDocumentId).toBe("first");
  expect(self.documentPart?.extent).toBe("section");
  await f.ingest(
    f.input({ post: "second", ordinal: 2, text: "Second section" }),
  );
  expect(await f.rows()).toEqual([own]);
  const parts = await f.parts();
  expect(parts).toHaveLength(2);
  expect(parts.every(({ hostDecisionId }) => hostDecisionId === own.id)).toBe(
    true,
  );
  expect(
    parts.every(({ declaredIdentifiers }) => declaredIdentifiers.length === 0),
  ).toBe(true);
  const decoded = parts.map(({ documentBodyS3Key }) => {
    const bytes =
      f.objects.get(documentBodyS3Key ?? "") ?? panic("Part snapshot missing");
    return decodeCollectionDocumentBody(bytes).unwrap().text;
  });
  expect(decoded).toContain(
    "Common report prefix\nFirst section\nCommon report suffix",
  );
  expect(decoded).toContain(
    "Common report prefix\nSecond section\nCommon report suffix",
  );
  const objectCount = f.objects.size;
  await f.ingest(
    f.input({ post: "second", ordinal: 2, text: "Second section" }),
  );
  expect(await f.parts()).toEqual(parts);
  expect(f.objects.size).toBe(objectCount);
  const reparsed = {
    ...f.input({
      post: "second",
      ordinal: 2,
      text: "Corrected section extraction",
    }),
    rawHash: f.input({ post: "second", ordinal: 2, text: "Second section" })
      .rawHash,
  };
  await f.ingest(reparsed);
  const repaired =
    (await f.parts()).find(
      ({ sourceDocumentId }) => sourceDocumentId === "second",
    ) ?? panic("Reparsed post absent");
  const repairedBytes =
    f.objects.get(repaired.documentBodyS3Key ?? "") ??
    panic("Reparsed snapshot absent");
  expect(decodeCollectionDocumentBody(repairedBytes).unwrap().text).toContain(
    "Corrected section extraction",
  );
  await f.ingest(
    f.input({
      post: "complete",
      ordinal: 3,
      text: "First section\nSecond section",
      part: { extent: "complete", legalSentence: null, keywords: [] },
    }),
  );
  expect(
    (await f.parts()).map(({ documentPart }) => documentPart?.extent),
  ).toContain("complete");
  expect(await f.rows()).toEqual([own]);
});

test("an existing external host wins while both attributed ECLIs remain explicit", async () => {
  const f = await fixture(12);
  const official = f.input({
    post: "official",
    ordinal: 1,
    text: "Authoritative host body",
    ecli: "ECLI:US:SCOTUS:2024:2017",
  });
  await f.ingest(official, "publisher");
  const host =
    (
      await db
        .select()
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, f.publisher.id))
    ).at(0) ?? panic("Host absent");
  await f.ingest(
    f.input({
      post: "part",
      ordinal: 1,
      text: "Collection excerpt",
      ecli: "ECLI:US:SCOTUS:2024:2003",
    }),
  );
  expect(await f.rows()).toEqual([]);
  expect(
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, host.id)),
  ).toEqual([host]);
  expect((await f.parts()).at(0)?.matchEvidence).toEqual({
    status: "matched",
    basis: "court-docket-date",
    ecliDiscrepancy: {
      sourceValue: "ECLI:US:SCOTUS:2024:2003",
      hostValue: "ECLI:US:SCOTUS:2024:2017",
    },
  });
});

test("historical own ownership is parked without replacing its verified self-part", async () => {
  const f = await fixture(13);
  const item = f.input({
    post: "own",
    ordinal: 1,
    text: "Historical collection section",
  });
  await f.ingest(item);
  const own = await f.rows();
  const self = await f.parts();
  await f.ingest(
    f.input({ post: "official", ordinal: 1, text: "Authoritative decision" }),
    "publisher",
  );
  await f.ingest(item);
  expect(await f.rows()).toEqual(own);
  expect(await f.parts()).toEqual(self);
  const failures = await db
    .select()
    .from(caseLawIngestionFailureEvidence)
    .where(
      and(
        eq(caseLawIngestionFailureEvidence.sourceId, f.collection.id),
        eq(caseLawIngestionFailureEvidence.sourceDocumentId, "own"),
      ),
    );
  expect(failures).toHaveLength(1);
});

test("a failed new self-part upload cannot credit an own row as parsed", async () => {
  const f = await fixture(14);
  const failed: AttachToHeldDecisionOptions["rawPayloadWriter"] = () => {
    throw new TypeError("Fixture object store is unavailable");
  };
  const item = f.input({ post: "retry", ordinal: 1, text: "Retained section" });
  expect((await f.ingest(item, "collection", { writer: failed })).status).toBe(
    "retryable",
  );
  expect(await f.rows()).toEqual([]);
  expect(await f.parts()).toEqual([]);
  expect((await f.ingest(item)).status).toBe("complete");
  expect(await f.rows()).toHaveLength(1);
  expect(await f.parts()).toHaveLength(1);
});

test("concurrent sibling posts share one canonical row after both reserve absent owners", async () => {
  const f = await fixture(15);
  const ready = deferred();
  let arrivals = 0;
  const pauseAfterReservation = (post: string): ScopedDb => {
    let waited = false;
    return async (run) => {
      const result = await f.scopedDb(run);
      if (waited) {
        return result;
      }
      const claim = (
        await db
          .select({ id: caseLawDecisionSourceIdentities.decisionId })
          .from(caseLawDecisionSourceIdentities)
          .where(
            and(
              eq(caseLawDecisionSourceIdentities.sourceId, f.collection.id),
              eq(caseLawDecisionSourceIdentities.sourceDocumentId, post),
            ),
          )
          .limit(1)
      ).at(0);
      if (
        claim !== undefined &&
        (await db.$count(
          caseLawDecisions,
          eq(caseLawDecisions.sourceId, f.collection.id),
        )) === 0
      ) {
        waited = true;
        arrivals += 1;
        if (arrivals === 2) {
          ready.resolve(undefined);
        }
        await settledWithin(ready.promise, {
          description: "both provisional publisher reservations",
          timeoutMs: 30_000,
        });
      }
      return result;
    };
  };
  const results = await Promise.all([
    f.ingest(
      f.input({ post: "one", ordinal: 1, text: "First section" }),
      "collection",
      { scopedDb: pauseAfterReservation("one") },
    ),
    f.ingest(
      f.input({ post: "two", ordinal: 2, text: "Second section" }),
      "collection",
      { scopedDb: pauseAfterReservation("two") },
    ),
  ]);
  expect(arrivals).toBe(2);
  expect(results.map(({ status }) => status)).toEqual(["complete", "complete"]);
  const rows = await f.rows();
  expect(rows).toHaveLength(1);
  const host = rows.at(0) ?? panic("Canonical sibling host absent");
  expect(await f.parts()).toHaveLength(2);
  expect(
    (await f.parts()).every(({ hostDecisionId }) => hostDecisionId === host.id),
  ).toBe(true);
});

test("fresh ambiguity is durably parked without allocating an own row or snapshot", async () => {
  const f = await fixture(16);
  await f.ingest(
    f.input({ post: "official-one", ordinal: 1, text: "First held decision" }),
    "publisher",
  );
  await f.ingest(
    f.input({ post: "official-two", ordinal: 1, text: "Second held decision" }),
    "publisher",
  );
  expect(
    (
      await f.ingest(
        f.input({ post: "ambiguous", ordinal: 1, text: "Unresolved report" }),
      )
    ).status,
  ).toBe("complete");
  expect(await f.rows()).toEqual([]);
  expect(f.objects.size).toBe(0);
  const parked =
    (await f.parts()).at(0) ?? panic("Ambiguous post was not parked");
  expect(parked.hostDecisionId).toBeNull();
  expect(parked.matchEvidence).toEqual({
    status: "ambiguous",
    completeness: "complete",
  });
  expect(
    await db.$count(
      caseLawIngestionFailureEvidence,
      eq(caseLawIngestionFailureEvidence.sourceId, f.collection.id),
    ),
  ).toBe(1);
});

test("a textless re-observation cannot discard a retained collection document", async () => {
  const f = await fixture(17);
  await f.ingest(
    f.input({ post: "part", ordinal: 1, text: "Retained section" }),
  );
  const prior = await f.parts();
  const empty = {
    ...f.input({
      post: "part",
      ordinal: 1,
      text: "",
      part: { extent: "unclassified", legalSentence: null, keywords: [] },
    }),
    documentAst: EMPTY_AST,
    fulltext: "",
    rawHash: "empty-source-observation",
  };
  const outcome = await f.ingestOutcome(empty);
  if (outcome.isOk()) {
    panic("Textless replacement unexpectedly succeeded");
  }
  expect(outcome.error).toMatchObject({
    field: UNPERSISTABLE_DECISION_FIELDS.HELD_DECISION_ATTACHMENT,
  });
  expect(await f.parts()).toEqual(prior);
});

test("approved aliases route repeated parts but changed identity preserves the historical binding", async () => {
  const f = await fixture(18);
  const input = f.input({
    post: "legacy-part",
    ordinal: 1,
    text: "Historical section",
  });
  await f.ingest(input);
  const original = (await f.rows()).at(0) ?? panic("Historical owner absent");
  const canonicalId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    ...original,
    id: canonicalId,
    slug: `fixture-canonical-${canonicalId}`,
    sourceDocumentId: "canonical-report",
  });
  await db.insert(caseLawDecisionAliases).values({
    retiredDecisionId: original.id,
    canonicalDecisionId: canonicalId,
  });
  await f.ingest(input);
  // Identical replay retains the original immutable snapshot owner; the approved alias resolves it.
  expect((await f.parts()).at(0)?.hostDecisionId).toBe(original.id);
  const parts = await f.parts();
  const canonical = await db
    .select()
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, canonicalId));
  await f.ingest({
    ...input,
    caseNumber: "24-999",
    decisionDate: "2025-01-01",
    rawHash: "conflicting-replay",
  });
  expect(await f.parts()).toEqual(parts);
  expect(
    await db
      .select()
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, canonicalId)),
  ).toEqual(canonical);
  expect(await f.rows()).toHaveLength(2);
});
