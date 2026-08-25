import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import {
  CASE_LAW_REPLAY_SCOPE,
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
} from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";

// A writing replay, through the same `processDecision` a crawl feeds.
//
// Two properties are asserted here that the module cannot state on its own:
// the pipeline really does write the re-parsed payload and clear the search
// projection's staleness marker, and a second run over an unchanged payload
// reaches a fixed point instead of rewriting the row again.
//
// The object store is the one thing that cannot be stood up in-process, so
// the raw-payload upload is recorded rather than performed. Its key matters:
// the pipeline writes that key onto the row, so an upload keyed on anything
// other than the payload's own hash would move the row's pointer.

const uploads: { key: string; contentType: string }[] = [];

beforeEach(() => {
  uploads.length = 0;
});

// The real module is spread back in: `mock.module` is process-global, so a
// partial mock would delete the other exports for every later test file.
const realS3 = await import("@/api/lib/s3");

void mock.module("@/api/lib/s3", () => ({
  ...realS3,
  writeS3ObjectWithRetry: async ({
    key,
    contentType,
  }: {
    key: string;
    contentType: string;
  }) => {
    uploads.push({ key, contentType });
    await Promise.resolve();
  },
}));

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

const { createTestPglite } = await import("@/api/tests/pglite-test-db");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the pipeline expects.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

const STORED_PAYLOAD =
  "<html><body>the payload the ingest stored</body></html>";
const STORED_KEY_PLACEHOLDER = "case-law/raw/legacy/placeholder";
/**
 * Carries a citation the extractor recognises, so the assertions can show
 * that going through the pipeline re-derives the citation graph from the
 * re-parsed text rather than leaving the old rows in place.
 */
const NEW_PARSER_TEXT =
  "What the new parser draws out of the stored payload, citing C-283/81.";

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

const stubAdapter = (
  reparse: NonNullable<SourceAdapter["reparseStoredRaw"]>,
): SourceAdapter => ({
  key: ADAPTER_KEYS.EU_ECJ,
  name: "replay apply stub",
  country: "EU",
  language: "en",
  minRequestIntervalMs: 0,
  fetchPage: async () => {
    throw new Error("a replay must never fetch from the publisher");
  },
  getTotalCount: async () => {
    throw new Error("a replay must never fetch from the publisher");
  },
  reconciliation: {
    firstSlice: "1970-01-01",
    sliceOf: () => "1970-01-01",
    nextSlice: () => null,
    previousSlice: () => null,
    tipWindowDays: 1,
    listSlicePage: async () => {
      throw new Error("a replay must never list the publisher");
    },
    buildDecision: async () => {
      throw new Error("a replay must never build from publisher data");
    },
  },
  reparseStoredRaw: reparse,
});

/** Stands in for a parser that draws different text out of the payload. */
const textChangingAdapter = stubAdapter((stored) => ({
  type: "parsed",
  result: {
    caseNumber: stored.caseNumber,
    court: stored.court,
    country: "EU",
    language: stored.language,
    metadata: stored.metadata,
    rawHash: "hash-from-the-new-parser",
    fulltext: NEW_PARSER_TEXT,
    documentAst: EMPTY_AST,
  },
}));

test("a writing replay goes through the pipeline, and replaying again converges", async () => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `replay-apply-${sourceId}`,
    name: "replay apply fixture",
  });
  const id = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id,
    sourceId,
    caseNumber: "C-9/26",
    court: "Court of Justice",
    country: "EU",
    language: "en",
    sourceRawS3Key: STORED_KEY_PLACEHOLDER,
    sourceRawContentType: "application/xhtml+xml",
    sourceHash: "hash-before-the-parser-changed",
    metadata: { celex: "62026CJ0009" },
  });

  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId,
  });
  if (sourceLease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }

  const adapter = textChangingAdapter;
  const replay = async () =>
    await replayCaseLawSource({
      adapter,
      scopedDb,
      sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: async () =>
        await Promise.resolve(new TextEncoder().encode(STORED_PAYLOAD)),
      sourceLease,
      limit: 10,
      pageSize: 10,
    });

  const first = await replay();
  if (first.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(first.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);

  // The payload the replay read is uploaded under its own content hash, and
  // under the media type the row recorded. A re-parse that returned no
  // payload would otherwise clear the row's pointer to it.
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(STORED_PAYLOAD);
  const contentAddressedKey = `case-law/raw/${sourceId}/${hasher.digest("hex")}`;
  expect(uploads).toEqual([
    { key: contentAddressedKey, contentType: "application/xhtml+xml" },
  ]);

  // The pipeline's own write: payload, source hash, the raw-payload pointer
  // and the search projection's staleness marker.
  const [applied] = await db
    .select({
      fulltext: caseLawDecisions.fulltext,
      sourceHash: caseLawDecisions.sourceHash,
      sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
      indexedHash: caseLawDecisions.indexedHash,
      observationOrder: caseLawDecisions.sourceObservationOrder,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  expect(applied).toEqual({
    fulltext: NEW_PARSER_TEXT,
    sourceHash: "hash-from-the-new-parser",
    sourceRawS3Key: contentAddressedKey,
    indexedHash: null,
    observationOrder: 1n,
  });

  // Same payload, same parser: the second run re-derives the stored hash, so
  // the pipeline advances the observation watermark and rewrites nothing.
  // That fixed point is what makes a re-run safe.
  const second = await replay();
  if (second.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);

  const [converged] = await db
    .select({
      fulltext: caseLawDecisions.fulltext,
      sourceHash: caseLawDecisions.sourceHash,
      sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
      observationOrder: caseLawDecisions.sourceObservationOrder,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  expect(converged).toEqual({
    fulltext: NEW_PARSER_TEXT,
    sourceHash: "hash-from-the-new-parser",
    sourceRawS3Key: contentAddressedKey,
    observationOrder: 2n,
  });
  // A converged replay re-reads the payload but has nothing to store.
  expect(uploads).toHaveLength(1);

  // Citation extraction ran on the re-parsed text: the reason a replay goes
  // through the pipeline instead of writing the payload columns itself.
  const citations = await db
    .select({ citationText: caseLawCitations.citationText })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.citingDecisionId, id));
  expect(citations.map(({ citationText }) => citationText)).toEqual([
    "C-283/81",
  ]);

  await sourceLease.release();
});

// A parser that restructures a document without changing its words is the
// ordinary shape of a parser improvement, and it moves neither the source
// hash (the publisher's bytes are the stored ones) nor the flattened text.
// A replay keyed on the source hash alone would call this "unchanged" and
// apply none of it — which would leave the tool unable to perform the
// migration it exists for.
const RESTRUCTURED_TEXT = "Alpha. Beta.";

const astWithBlocks = (blocks: DocumentAst["blocks"]): DocumentAst => ({
  version: 1,
  source: {
    system: ADAPTER_KEYS.EU_ECJ,
    documentId: "restructure",
    webUrl: "https://example.test/web",
    printUrl: "",
  },
  metadata: {
    caseNumber: "C-10/26",
    ecli: null,
    court: "Court of Justice",
    decisionDate: null,
    decisionType: null,
    keywords: [],
    statutes: [],
  },
  blocks,
});

const paragraph = (id: string, text: string) => ({
  id,
  anchorId: id,
  type: "paragraph" as const,
  inlines: [{ type: "text" as const, text }],
  plainText: text,
});

/** One paragraph carrying both sentences. */
const FLAT_AST = astWithBlocks([paragraph("b1", RESTRUCTURED_TEXT)]);
/** The same words, split the way an improved parser would split them. */
const STRUCTURED_AST = astWithBlocks([
  paragraph("b1", "Alpha."),
  paragraph("b2", "Beta."),
]);

const STORED_SECTIONS: DecisionSection[] = [
  { index: 0, type: "unknown", title: null, text: RESTRUCTURED_TEXT },
];

test("a restructure the flattened text does not show is still applied", async () => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `replay-restructure-${sourceId}`,
    name: "replay restructure fixture",
  });
  const id = createSafeId<"caseLawDecision">();
  const storedMetadata = { celex: "62026CJ0010" };
  await db.insert(caseLawDecisions).values({
    id,
    sourceId,
    caseNumber: "C-10/26",
    court: "Court of Justice",
    country: "EU",
    language: "en",
    fulltext: RESTRUCTURED_TEXT,
    sections: STORED_SECTIONS,
    documentAst: FLAT_AST,
    parserVersion: 3,
    sourceRawS3Key: STORED_KEY_PLACEHOLDER,
    sourceRawContentType: "application/xhtml+xml",
    sourceHash: "hash-that-does-not-move",
    metadata: storedMetadata,
  });

  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId,
  });
  if (sourceLease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }

  // Everything the source hash covers is identical to what is stored: same
  // hash, same metadata, same flattened text, same sections, same parser
  // version. Only the structure moved.
  const restructuringAdapter = stubAdapter((stored) => ({
    type: "parsed",
    result: {
      caseNumber: stored.caseNumber,
      court: stored.court,
      country: "EU",
      language: stored.language,
      metadata: stored.metadata,
      rawHash: "hash-that-does-not-move",
      fulltext: RESTRUCTURED_TEXT,
      sections: STORED_SECTIONS,
      documentAst: STRUCTURED_AST,
      parserVersion: 3,
    },
  }));

  const run = await replayCaseLawSource({
    adapter: restructuringAdapter,
    scopedDb,
    sourceId,
    scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
    readStoredRaw: async () =>
      await Promise.resolve(new TextEncoder().encode(STORED_PAYLOAD)),
    sourceLease,
    limit: 10,
    pageSize: 10,
  });

  if (run.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(run.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
  expect(run.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(0);

  const [rewritten] = await db
    .select({
      documentAst: caseLawDecisions.documentAst,
      fulltext: caseLawDecisions.fulltext,
      sourceHash: caseLawDecisions.sourceHash,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  expect(rewritten).toEqual({
    documentAst: STRUCTURED_AST,
    fulltext: RESTRUCTURED_TEXT,
    sourceHash: "hash-that-does-not-move",
  });

  // And it still converges: the row now holds the structure the parser
  // produces, so a second pass has nothing to write.
  const second = await replayCaseLawSource({
    adapter: restructuringAdapter,
    scopedDb,
    sourceId,
    scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
    readStoredRaw: async () =>
      await Promise.resolve(new TextEncoder().encode(STORED_PAYLOAD)),
    sourceLease,
    limit: 10,
    pageSize: 10,
  });
  if (second.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);

  await sourceLease.release();
});
