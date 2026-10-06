import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import {
  DECISION_TEXT_ABSENCE_METADATA_KEY,
  DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
  DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY,
  TEXT_ABSENCE_REASONS,
} from "@stll/api-contract/case-law-text-field";
import { DECISION_DOCUMENT_ROLE } from "@stll/api-contract/decision-document-role";
import { assertProperty } from "@stll/property-testing";
import { createSha256 } from "@stll/sha256/bun";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawCorpusUploadIntents,
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  relations,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  EMPTY_AST,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/handlers/case-law/ingestion/adapter";
import type {
  IngestionResult,
  SourceAdapter,
} from "@/api/handlers/case-law/ingestion/adapter";
import { EU_ECJ_METADATA_URL_SCHEMA } from "@/api/handlers/case-law/ingestion/adapters/eu-ecj.metadata-urls";
import {
  assembleSkCourtsDecision,
  skCourtsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/sk-courts";
import { caseLawCanonicalPayload } from "@/api/handlers/case-law/ingestion/pipeline/corpus-mirror";
import {
  CASE_LAW_REPLAY_SCOPE,
  REPLAY_REJECTION_POLICY,
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
  replayRowResult,
} from "@/api/handlers/case-law/ingestion/replay";
import type {
  ReplayCaseLawSourceOptions,
  ReplayRejectionPolicy,
  ReplayRowReport,
  ReplayRowResult,
} from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  presentTextField,
  splitStoredDecisionTextMetadata,
} from "@/api/lib/case-law/decision-text";
import { ConcurrentModificationError } from "@/api/lib/errors/tagged-errors";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { corpusContentHash } from "@/api/lib/legal-search/corpus-storage";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { sanitizeResult } from "@/api/lib/legal-search/ingestion-normalization";
import { approveMetadataUrls } from "@/api/lib/legal-search/metadata-urls";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { toMetadataUrl } from "@/api/lib/sanitize-url";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// A writing replay, through the same `processDecision` a crawl feeds.
//
// Two properties are asserted here that the module cannot state on its own:
// the pipeline really does write the re-parsed payload, and a second run over
// an unchanged payload reaches a fixed point instead of rewriting the row
// again.
//
// The raw-payload upload runs against an in-process object store, so the
// object itself is the assertion. Its key matters: the pipeline writes that
// key onto the row, so an upload keyed on anything other than the payload's
// own hash would move the row's pointer at the object it names.

let fake: FakeS3;

beforeEach(() => {
  decisionUpdates.length = 0;
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
});

const decisionUpdates: string[] = [];
const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
    logger: {
      logQuery: (query) => {
        if (/^update "case_law_decisions"/iu.test(query)) {
          decisionUpdates.push(query);
        }
      },
    },
  });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the pipeline expects.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
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
  documentStage: "inline",
  observeDocumentStage: async ({ fetchPage }) => await fetchPage(),
  sourceFields: { status: "declared", fields: {}, listSourceFields: () => [] },
  sourceSurfaces: { surfaces: {} },
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
    revisionOf: (payload) => payload,
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
  result: plainTextIngestionResult({
    caseNumber: stored.caseNumber,
    court: stored.court,
    country: "EU",
    language: stored.language,
    ...splitStoredDecisionTextMetadata(stored.metadata),
    rawHash: "hash-from-the-new-parser",
    fulltext: NEW_PARSER_TEXT,
    documentAst: EMPTY_AST,
  }),
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
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });

  const first = await replay();
  if (first.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(first.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);

  // The payload the replay read landed under its own content hash, in the
  // decision's own prefix, byte for byte, and under the media type the row
  // recorded. A re-parse that returned no payload would otherwise clear the
  // row's pointer to it.
  const hasher = createSha256();
  hasher.update(STORED_PAYLOAD);
  const contentAddressedKey = `case-law/raw/${sourceId}/documents/${id}/payloads/${hasher.digest("hex")}`;
  const stored = fake.objects.get(
    `${envBase.S3_BUCKET}/${contentAddressedKey}`,
  );
  expect(new TextDecoder().decode(stored?.bytes)).toBe(STORED_PAYLOAD);
  // The charset parameter is the client's; the media type is the row's, and
  // it is what a later read of this object reports.
  expect(stored?.contentType).toMatch(/^application\/xhtml\+xml\b/u);
  expect(fake.objects.size).toBe(1);

  // The pipeline's own write: payload, source hash, the raw-payload pointer
  // and the observation watermark.
  const [applied] = await db
    .select({
      fulltext: caseLawDecisions.fulltext,
      sourceHash: caseLawDecisions.sourceHash,
      sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
      observationOrder: caseLawDecisions.sourceObservationOrder,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  expect(applied).toEqual({
    fulltext: NEW_PARSER_TEXT,
    sourceHash: "hash-from-the-new-parser",
    sourceRawS3Key: contentAddressedKey,
    observationOrder: 1n,
  });

  // Same payload, same parser: the second run re-derives the stored hash, so
  // neither the decision nor its observation watermark is written.
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
    observationOrder: 1n,
  });
  // A converged replay re-reads the payload but has nothing to store: the
  // key the row already records names an object with these exact bytes.
  expect(fake.requests.filter(({ method }) => method === "PUT")).toHaveLength(
    1,
  );

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
    result: plainTextIngestionResult({
      caseNumber: stored.caseNumber,
      court: stored.court,
      country: "EU",
      language: stored.language,
      ...splitStoredDecisionTextMetadata(stored.metadata),
      rawHash: "hash-that-does-not-move",
      fulltext: RESTRUCTURED_TEXT,
      sections: STORED_SECTIONS,
      documentAst: STRUCTURED_AST,
      parserVersion: 3,
    }),
  }));

  const run = await replayCaseLawSource({
    adapter: restructuringAdapter,
    scopedDb,
    sourceId,
    scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
    readStoredRaw: async () =>
      await Promise.resolve(new TextEncoder().encode(STORED_PAYLOAD)),
    sourceLease,
    bound: { type: "at-most", limit: 10 },
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
    bound: { type: "at-most", limit: 10 },
    pageSize: 10,
  });
  if (second.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);

  await sourceLease.release();
});

// A hardened parser can decide that what a row holds was never a document —
// a page the publisher served where a decision would be. Re-parsing such a
// row yields no result, so the pipeline has nothing to write over it and the
// text stands until something takes it back.
const noDocumentAdapter = stubAdapter(() => ({
  type: "rejected",
  rejection: STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT,
  detail: "no fulltext parsed from the stored payload",
}));

const STORED_PAGE_TEXT = "Site navigation, contact options and a footer.";

type WithdrawFixture = {
  id: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
};

const insertRowHoldingAPage = async ({
  label,
  caseNumber = "C-11/26",
  intoSource,
}: {
  label: string;
  caseNumber?: string;
  /** Put the row on an existing source, to walk several in one run. */
  intoSource?: SafeId<"caseLawSource">;
}): Promise<WithdrawFixture> => {
  const sourceId = intoSource ?? createSafeId<"caseLawSource">();
  if (intoSource === undefined) {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: `replay-${label}-${sourceId}`,
      name: `replay ${label} fixture`,
    });
  }
  const id = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id,
    sourceId,
    caseNumber,
    court: "Court of Justice",
    country: "EU",
    language: "ga",
    fulltext: STORED_PAGE_TEXT,
    sections: [
      { index: 0, type: "unknown", title: null, text: STORED_PAGE_TEXT },
    ],
    sourceRawS3Key: STORED_KEY_PLACEHOLDER,
    sourceRawContentType: "application/xhtml+xml",
    sourceHash: "hash-of-the-page-that-was-stored",
    metadata: { celex: "62026CJ0011" },
  });
  return { id, sourceId };
};

const withdrawingReplay = async ({
  sourceId,
  sourceLease,
  rejectionPolicy,
  withdraw,
}: {
  sourceId: SafeId<"caseLawSource">;
  sourceLease: CaseLawSourceIngestionLease | null;
  rejectionPolicy: ReplayRejectionPolicy;
  /** Stands in for the withdrawal when the branch under test is its result. */
  withdraw?: ReplayCaseLawSourceOptions["withdraw"];
}) =>
  await replayCaseLawSource({
    adapter: noDocumentAdapter,
    scopedDb,
    sourceId,
    scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
    readStoredRaw: async () =>
      await Promise.resolve(new TextEncoder().encode(STORED_PAYLOAD)),
    sourceLease,
    bound: { type: "at-most", limit: 10 },
    pageSize: 10,
    rejectionPolicy,
    ...(withdraw === undefined ? {} : { withdraw }),
  });

const storedDocumentOf = async (id: SafeId<"caseLawDecision">) => {
  const [row] = await db
    .select({
      fulltext: caseLawDecisions.fulltext,
      sections: caseLawDecisions.sections,
      documentAst: caseLawDecisions.documentAst,
      contentHash: caseLawDecisions.contentHash,
      caseNumber: caseLawDecisions.caseNumber,
      metadata: caseLawDecisions.metadata,
      sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  return row;
};

test("a row that re-parses to no document keeps its text unless asked", async () => {
  const { id, sourceId } = await insertRowHoldingAPage({ label: "rejected" });
  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId,
  });
  if (sourceLease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }

  const run = await withdrawingReplay({
    sourceId,
    sourceLease,
    rejectionPolicy: REPLAY_REJECTION_POLICY.REPORT,
  });
  if (run.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }

  // The default: a re-parse that finds nothing is reported, not acted on.
  // Most such rejections are the replay failing to read the row, and a run
  // that emptied rows on that reading would be unrecoverable.
  expect(run.report.outcomes[REPLAY_ROW_OUTCOME.REJECTED]).toBe(1);
  expect(run.report.outcomes[REPLAY_ROW_OUTCOME.WITHDRAWN]).toBe(0);
  expect((await storedDocumentOf(id))?.fulltext).toBe(STORED_PAGE_TEXT);

  await sourceLease.release();
});

test("the withdrawal takes the document and keeps the decision", async () => {
  const { id, sourceId } = await insertRowHoldingAPage({ label: "withdraw" });

  // The dry run says what it would do and does none of it, so the count an
  // operator decides on is the one the applying run acts on.
  const dry = await withdrawingReplay({
    sourceId,
    sourceLease: null,
    rejectionPolicy: REPLAY_REJECTION_POLICY.WITHDRAW_NO_DOCUMENT,
  });
  if (dry.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(dry.report.outcomes[REPLAY_ROW_OUTCOME.WOULD_WITHDRAW]).toBe(1);
  expect((await storedDocumentOf(id))?.fulltext).toBe(STORED_PAGE_TEXT);

  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId,
  });
  if (sourceLease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }

  const run = await withdrawingReplay({
    sourceId,
    sourceLease,
    rejectionPolicy: REPLAY_REJECTION_POLICY.WITHDRAW_NO_DOCUMENT,
  });
  if (run.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(run.report.outcomes[REPLAY_ROW_OUTCOME.WITHDRAWN]).toBe(1);
  // Still counted under the reason the re-parse gave, so the report says
  // why each withdrawn row was withdrawn.
  expect(run.report.rejections[STORED_RAW_REPARSE_REJECTION.NO_DOCUMENT]).toBe(
    1,
  );
  expect(run.report.problems.map(({ id: problemId }) => problemId)).toEqual([
    id,
  ]);

  // The document is gone from every column a reader is served from, and the
  // content hash with it: a null hash is what turns the row's projection
  // into an erase for every generation. The decision itself stays — its
  // identity, its metadata, and the stored payload a later parser fix would
  // replay from.
  expect(await storedDocumentOf(id)).toEqual({
    fulltext: null,
    sections: null,
    documentAst: null,
    contentHash: null,
    caseNumber: "C-11/26",
    metadata: { celex: "62026CJ0011" },
    sourceRawS3Key: STORED_KEY_PLACEHOLDER,
  });

  // The row that says a document left the corpus, and why. Written in the
  // same transaction as the columns above, and not as a redaction: a
  // redact row is read as a takedown tombstone, which this is not.
  const [audited] = await db
    .select({
      operation: caseLawIndexJobs.operation,
      status: caseLawIndexJobs.status,
      contentHash: caseLawIndexJobs.contentHash,
      detail: caseLawIndexJobs.detail,
      errorMessage: caseLawIndexJobs.errorMessage,
    })
    .from(caseLawIndexJobs)
    .where(eq(caseLawIndexJobs.decisionId, id));
  expect(audited?.operation).toBe("withdraw");
  expect(audited?.status).toBe("succeeded");
  expect(audited?.contentHash).toBeNull();
  // The reason is the detail of an operation that succeeded. The failure
  // column stays clear: a reader takes anything in it as this row's failure.
  expect(audited?.detail).toContain("re-parse yielded no document");
  expect(audited?.errorMessage).toBeNull();

  // And it converges: the row holds no document to take, so a second run
  // reports the rejection and withdraws nothing.
  const second = await withdrawingReplay({
    sourceId,
    sourceLease,
    rejectionPolicy: REPLAY_REJECTION_POLICY.WITHDRAW_NO_DOCUMENT,
  });
  if (second.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.WITHDRAWN]).toBe(0);
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.REJECTED]).toBe(1);

  await sourceLease.release();
});

test("a corpus object that outlives its delete leaves the row alone", async () => {
  // Both rows sit on one source, so the second also proves the walk went
  // past the first: an object nobody can delete must not pin every later
  // row behind it.
  const first = await insertRowHoldingAPage({ label: "incomplete" });
  const second = await insertRowHoldingAPage({
    label: "incomplete",
    caseNumber: "C-12/26",
    intoSource: first.sourceId,
  });

  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId: first.sourceId,
  });
  if (sourceLease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }

  const run = await withdrawingReplay({
    sourceId: first.sourceId,
    sourceLease,
    rejectionPolicy: REPLAY_REJECTION_POLICY.WITHDRAW_NO_DOCUMENT,
    // The withdrawal reports that an object still holds the payload, which
    // is what it does when a delete cannot be confirmed.
    withdraw: async () =>
      await Promise.resolve(
        Result.ok({
          type: "corpus-objects-remain",
          error: new Error("the object store refused the delete"),
        }),
      ),
  });
  if (run.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }

  expect(run.report.outcomes[REPLAY_ROW_OUTCOME.WITHDRAW_INCOMPLETE]).toBe(2);
  expect(run.report.outcomes[REPLAY_ROW_OUTCOME.WITHDRAWN]).toBe(0);
  expect(run.report.haltReason).toBeNull();
  expect(run.report.resumeAfter).not.toBeNull();
  expect(
    run.report.problems.map(({ outcome, detail }) => ({
      outcome,
      holds: detail?.includes("a corpus object still holds the payload"),
    })),
  ).toEqual([
    { outcome: REPLAY_ROW_OUTCOME.WITHDRAW_INCOMPLETE, holds: true },
    { outcome: REPLAY_ROW_OUTCOME.WITHDRAW_INCOMPLETE, holds: true },
  ]);

  // The point of the branch: both rows still hold their document, so the
  // next run has something to withdraw rather than a row that reads as
  // already done.
  for (const { id } of [first, second]) {
    expect((await storedDocumentOf(id))?.fulltext).toBe(STORED_PAGE_TEXT);
  }

  await sourceLease.release();
});

const replayConvergenceFixture = async (text: string) => {
  const sourceId = createSafeId<"caseLawSource">();
  const id = createSafeId<"caseLawDecision">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `replay-convergence-${sourceId}`,
    name: "replay convergence fixture",
  });
  const result = plainTextIngestionResult({
    caseNumber: "C-10/26",
    court: "Court of Justice",
    country: "EU",
    language: "en",
    metadata: { celex: "62026CJ0010" },
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
    rawHash: "convergence-source-hash",
    fulltext: text,
    sections: [{ index: 0, type: "unknown" as const, title: null, text }],
    documentAst: astWithBlocks([paragraph("b1", text)]),
    parserVersion: 4,
  });
  const sanitized = sanitizeResult(result);
  const payload = caseLawCanonicalPayload(sanitized);
  await db.insert(caseLawDecisions).values({
    id,
    sourceId,
    caseNumber: sanitized.caseNumber,
    court: sanitized.court,
    country: sanitized.country,
    language: sanitized.language,
    metadata: sanitized.metadata,
    fulltext: payload.text,
    sections: payload.sections,
    documentAst: payload.ast,
    parserVersion: 4,
    sourceHash: sanitized.rawHash,
    sourceRawS3Key: STORED_KEY_PLACEHOLDER,
    sourceRawContentType: "application/xhtml+xml",
  });
  const adapter = stubAdapter(() => ({ type: "parsed", result }));
  const replay = async (sourceLease: CaseLawSourceIngestionLease | null) =>
    await replayCaseLawSource({
      adapter,
      scopedDb,
      sourceId,
      sourceLease,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: async () => new TextEncoder().encode(STORED_PAYLOAD),
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });
  return { sourceId, id, result, sanitized, payload, replay };
};

test.each(TEXT_ABSENCE_REASONS)(
  "explicit %s absence writes survive a partial replay and resume at a fixed point",
  async (reason) => {
    const fixture = await replayConvergenceFixture("Unchanged body text.");
    const secondId = createSafeId<"caseLawDecision">();
    const legacyMetadata = {
      celex: "62026CJ0010",
      ...(reason === TEXT_ABSENCE_REASON.NOT_PUBLISHED
        ? {}
        : {
            [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
              { field: "abstract", reason },
              { field: "legalSentence", reason },
              { field: "summary", reason },
            ],
          }),
    };
    await db
      .update(caseLawDecisions)
      .set({
        metadata: legacyMetadata,
        sourceHash: "before-explicit-absence",
        parserVersion: 3,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      })
      .where(eq(caseLawDecisions.id, fixture.id));
    await db.insert(caseLawDecisions).values({
      id: secondId,
      sourceId: fixture.sourceId,
      caseNumber: "C-11/26",
      court: fixture.result.court,
      country: fixture.result.country,
      language: fixture.result.language,
      metadata: legacyMetadata,
      sourceHash: "before-explicit-absence",
      parserVersion: 3,
      sourceRawS3Key: "case-law/raw/legacy/second",
      sourceRawContentType: "application/xhtml+xml",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const textFields = {
      ...absentDecisionTextFields(reason),
      headnote: presentTextField("Published headnote"),
    };
    const expectedMetadata = {
      ...legacyMetadata,
      headnote: "Published headnote",
      [DECISION_TEXT_ABSENCE_VERSION_METADATA_KEY]:
        DECISION_TEXT_ABSENCE_SCHEMA_VERSION,
      [DECISION_TEXT_ABSENCE_METADATA_KEY]: [
        { field: "abstract", reason },
        { field: "legalSentence", reason },
        { field: "summary", reason },
      ],
    };
    const adapter = stubAdapter((stored) => ({
      type: "parsed",
      result: plainTextIngestionResult({
        ...fixture.result,
        caseNumber: stored.caseNumber,
        textFields,
        rawHash: "after-explicit-absence",
      }),
    }));
    const lease = await acquireCaseLawSourceIngestionLease({
      scopedDb,
      sourceId: fixture.sourceId,
    });
    if (lease === null) {
      throw new TypeError("Expected the source ingestion lease to be free");
    }
    const readMetadata = async () =>
      await db
        .select({
          id: caseLawDecisions.id,
          metadata: caseLawDecisions.metadata,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, fixture.sourceId))
        .orderBy(caseLawDecisions.createdAt, caseLawDecisions.id);
    const options = {
      adapter,
      scopedDb,
      sourceId: fixture.sourceId,
      sourceLease: lease,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      bound: { type: "at-most", limit: 10 },
      pageSize: 1,
    } as const satisfies Omit<ReplayCaseLawSourceOptions, "readStoredRaw">;
    const failed = await replayCaseLawSource({
      ...options,
      readStoredRaw: async (key) => {
        if (key === "case-law/raw/legacy/second") {
          throw new TypeError("Injected second payload read failure");
        }
        return new TextEncoder().encode(STORED_PAYLOAD);
      },
    });
    if (failed.type !== "ran") {
      throw new TypeError("Expected replay to run");
    }
    expect(failed.report.visited).toBe(1);
    expect(failed.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
    expect(failed.report.haltReason).toContain(
      "Injected second payload read failure",
    );
    expect(failed.report.resumeAfter).toBe(fixture.id);
    expect(await readMetadata()).toEqual([
      { id: fixture.id, metadata: expectedMetadata },
      { id: secondId, metadata: legacyMetadata },
    ]);

    const resumed = await replayCaseLawSource({
      ...options,
      after: failed.report.resumeAfter,
      readStoredRaw: async () => new TextEncoder().encode(STORED_PAYLOAD),
    });
    if (resumed.type !== "ran") {
      throw new TypeError("Expected resumed replay to run");
    }
    expect(resumed.report.visited).toBe(1);
    expect(resumed.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
    expect(resumed.report.haltReason).toBeNull();
    expect(resumed.report.resumeAfter).toBe(secondId);
    const complete = [
      { id: fixture.id, metadata: expectedMetadata },
      { id: secondId, metadata: expectedMetadata },
    ];
    expect(await readMetadata()).toEqual(complete);

    const repeated = await replayCaseLawSource({
      ...options,
      readStoredRaw: async () => new TextEncoder().encode(STORED_PAYLOAD),
    });
    if (repeated.type !== "ran") {
      throw new TypeError("Expected repeated replay to run");
    }
    expect(repeated.report.visited).toBe(2);
    expect(repeated.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(2);
    expect(repeated.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);
    expect(repeated.report.haltReason).toBeNull();
    expect(await readMetadata()).toEqual(complete);
    await lease.release();
  },
);

test("replay persists a newly derived reasons role and converges without changing the stated type", async () => {
  const fixture = await replayConvergenceFixture("Unchanged reasons text.");
  const statedType = "uzasadnienie";
  await db
    .update(caseLawDecisions)
    .set({ decisionType: statedType })
    .where(eq(caseLawDecisions.id, fixture.id));
  const result = plainTextIngestionResult({
    ...fixture.result,
    decisionType: statedType,
    documentRole: DECISION_DOCUMENT_ROLE.REASONS,
  });
  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId: fixture.sourceId,
  });
  if (sourceLease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }
  const replay = async () =>
    await replayCaseLawSource({
      adapter: stubAdapter(() => ({ type: "parsed", result })),
      scopedDb,
      sourceId: fixture.sourceId,
      sourceLease,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: async () => new TextEncoder().encode(STORED_PAYLOAD),
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });
  const snapshot = async () =>
    (
      await db
        .select({
          metadata: caseLawDecisions.metadata,
          decisionType: caseLawDecisions.decisionType,
          sourceHash: caseLawDecisions.sourceHash,
          fulltext: caseLawDecisions.fulltext,
          updatedAt: caseLawDecisions.updatedAt,
        })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, fixture.id))
    ).at(0);
  const before = await snapshot();
  expect(before?.metadata?.["documentRole"]).toBeUndefined();
  const first = await replay();
  if (first.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(first.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
  const applied = await snapshot();
  expect(applied?.metadata).toMatchObject({
    celex: "62026CJ0010",
    documentRole: DECISION_DOCUMENT_ROLE.REASONS,
  });
  expect(applied?.decisionType).toBe(statedType);
  expect(applied?.sourceHash).toBe(before?.sourceHash);
  expect(applied?.fulltext).toBe(before?.fulltext);

  const second = await replay();
  if (second.type !== "ran") {
    throw new TypeError("Expected the capable adapter to run");
  }
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);
  expect(await snapshot()).toEqual(applied);
  await sourceLease.release();
});

test.each(["r o z h o d o l :", "Body text.\u0000"])(
  "sanitized replay reaches a fixed point for %p",
  async (text) => {
    const fixture = await replayConvergenceFixture(text);
    expect(fixture.sanitized.fulltext).not.toBe(text);
    // Begin with a payload that needs the parser change, then reparse the
    // identical unsanitized source again against what the pipeline stored.
    await db
      .update(caseLawDecisions)
      .set({ fulltext: "Old text", sections: null, documentAst: EMPTY_AST })
      .where(eq(caseLawDecisions.id, fixture.id));
    const lease = await acquireCaseLawSourceIngestionLease({
      scopedDb,
      sourceId: fixture.sourceId,
    });
    if (lease === null) {
      throw new TypeError("Expected the source ingestion lease to be free");
    }
    const first = await fixture.replay(lease);
    if (first.type !== "ran") {
      throw new TypeError("Expected replay to run");
    }
    expect(first.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
    const second = await fixture.replay(lease);
    if (second.type !== "ran") {
      throw new TypeError("Expected replay to run");
    }
    expect(second.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
    expect(second.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);
    await lease.release();
  },
);

test.each(["row-columns", "content-hash"])(
  "an identical replay never updates the decision at a newer parser version: %p",
  async (storage) => {
    const fixture = await replayConvergenceFixture("Unchanged body text.");
    await db
      .update(caseLawDecisions)
      .set({
        parserVersion: 3,
        contentHash:
          storage === "content-hash"
            ? corpusContentHash(fixture.payload)
            : null,
        updatedAt: sql`'2026-01-01 00:00:00.123456+00'::timestamptz`,
      })
      .where(eq(caseLawDecisions.id, fixture.id));
    const readRow = async () =>
      (
        await db
          .select()
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, fixture.id))
      ).at(0);
    const before = await readRow();
    if (before === undefined) {
      throw new TypeError("Expected the fixture row");
    }
    const dry = await fixture.replay(null);
    if (dry.type !== "ran") {
      throw new TypeError("Expected replay to run");
    }
    expect(dry.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
    expect(await readRow()).toEqual(before);
    const lease = await acquireCaseLawSourceIngestionLease({
      scopedDb,
      sourceId: fixture.sourceId,
    });
    if (lease === null) {
      throw new TypeError("Expected the source ingestion lease to be free");
    }
    const updatesBefore = decisionUpdates.length;
    const run = await fixture.replay(lease);
    if (run.type !== "ran") {
      throw new TypeError("Expected replay to run");
    }
    expect(run.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
    expect(decisionUpdates.slice(updatesBefore)).toEqual([]);
    expect(await readRow()).toEqual(before);
    const [timestamp] = await db
      .select({ value: sql<string>`${caseLawDecisions.updatedAt}::text` })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, fixture.id));
    expect(timestamp?.value).toContain(".123456");
    expect(fake.requests.filter(({ method }) => method === "PUT")).toHaveLength(
      0,
    );
    expect(
      await db
        .select()
        .from(caseLawCorpusUploadIntents)
        .where(eq(caseLawCorpusUploadIntents.decisionId, fixture.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(caseLawIndexJobs)
        .where(eq(caseLawIndexJobs.decisionId, fixture.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(corpusIndexProjectionIntents)
        .where(eq(corpusIndexProjectionIntents.entityId, fixture.id)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, fixture.id)),
    ).toHaveLength(0);
    const [source] = await db
      .select({ order: caseLawSources.observationOrder })
      .from(caseLawSources)
      .where(eq(caseLawSources.id, fixture.sourceId));
    expect(source?.order).toBe(0n);
    const second = await fixture.replay(null);
    if (second.type !== "ran") {
      throw new TypeError("Expected replay to run");
    }
    expect(second.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
    await lease.release();
  },
);

test.each(["unchanged", "rejected", "missing-payload", "changed"] as const)(
  "an expired lease holds the replay cursor before completing a row: %s",
  async (outcome) => {
    const fixture = await replayConvergenceFixture("Unchanged body text.");
    const lease = await acquireCaseLawSourceIngestionLease({
      scopedDb,
      sourceId: fixture.sourceId,
    });
    if (lease === null) {
      panic("Expected free source lease");
    }
    const leaseLifetimeMs = 60 * 60 * 1000;
    let nowMs = 0;
    let expiresAtMs = leaseLifetimeMs;
    const expiringLease = {
      ...lease,
      beforeDatabaseMark: async () => {
        if (nowMs >= expiresAtMs) {
          throw new ConcurrentModificationError({
            message: "Case-law source ingestion lease was lost",
          });
        }
        expiresAtMs = nowMs + leaseLifetimeMs;
      },
    } satisfies CaseLawSourceIngestionLease;
    const recorded: ReplayRowReport[] = [];
    const replay = async (sourceLease: CaseLawSourceIngestionLease | null) =>
      await replayCaseLawSource({
        adapter: stubAdapter(() =>
          outcome === "rejected"
            ? {
                type: "rejected",
                rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
                detail: "Unsupported stored content",
              }
            : {
                type: "parsed",
                result:
                  outcome === "changed"
                    ? { ...fixture.result, rawHash: "changed-source-hash" }
                    : fixture.result,
              },
        ),
        scopedDb,
        sourceId: fixture.sourceId,
        sourceLease,
        scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
        readStoredRaw: async () => {
          nowMs += leaseLifetimeMs + 1;
          return outcome === "missing-payload"
            ? null
            : new TextEncoder().encode(STORED_PAYLOAD);
        },
        bound: { type: "at-most", limit: 10 },
        pageSize: 10,
        recordRow: async (row) => {
          recorded.push(row);
        },
      });
    try {
      const run = await replay(expiringLease);
      if (run.type !== "ran") {
        panic("Expected replay to run");
      }
      expect(run.report.visited).toBe(0);
      expect(run.report.resumeAfter).toBeNull();
      expect(run.report.haltReason).toContain("ingestion lease was lost");
      expect(recorded).toHaveLength(0);

      const dry = await replay(null);
      if (dry.type !== "ran") {
        panic("Expected dry replay to run");
      }
      expect(dry.report.visited).toBe(1);
      expect(dry.report.resumeAfter).toBe(fixture.id);
      expect(dry.report.haltReason).toBeNull();
      expect(recorded).toHaveLength(1);
      const dryOutcomes = {
        changed: REPLAY_ROW_OUTCOME.WOULD_APPLY,
        "missing-payload": REPLAY_ROW_OUTCOME.MISSING_PAYLOAD,
        rejected: REPLAY_ROW_OUTCOME.REJECTED,
        unchanged: REPLAY_ROW_OUTCOME.UNCHANGED,
      } as const;
      expect(dry.report.outcomes[dryOutcomes[outcome]]).toBe(1);
    } finally {
      await lease.release();
    }
  },
);

test("an unchanged replay preserves a version written after the row was selected", async () => {
  const fixture = await replayConvergenceFixture("Unchanged body text.");
  await db
    .update(caseLawDecisions)
    .set({ parserVersion: 3 })
    .where(eq(caseLawDecisions.id, fixture.id));
  const lease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId: fixture.sourceId,
  });
  if (lease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }
  const run = await replayCaseLawSource({
    adapter: stubAdapter(() => ({ type: "parsed", result: fixture.result })),
    scopedDb,
    sourceId: fixture.sourceId,
    sourceLease: lease,
    scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
    readStoredRaw: async () => {
      await db
        .update(caseLawDecisions)
        .set({
          parserVersion: 9,
          updatedAt: sql`${caseLawDecisions.updatedAt}`,
        })
        .where(eq(caseLawDecisions.id, fixture.id));
      return new TextEncoder().encode(STORED_PAYLOAD);
    },
    bound: { type: "at-most", limit: 10 },
    pageSize: 10,
  });
  if (run.type !== "ran") {
    throw new TypeError("Expected replay to run");
  }
  expect(run.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
  const [row] = await db
    .select({ version: caseLawDecisions.parserVersion })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, fixture.id));
  expect(row?.version).toBe(9);
  expect(fake.requests.filter(({ method }) => method === "PUT")).toHaveLength(
    0,
  );
  await lease.release();
});

test("a version bump that changes only a described column goes through the pipeline", async () => {
  const fixture = await replayConvergenceFixture("Unchanged body text.");
  await db
    .update(caseLawDecisions)
    .set({ parserVersion: 3, decisionType: "order" })
    .where(eq(caseLawDecisions.id, fixture.id));
  const lease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId: fixture.sourceId,
  });
  if (lease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }
  const run = await replayCaseLawSource({
    adapter: stubAdapter(() => ({
      type: "parsed",
      result: plainTextIngestionResult({
        ...fixture.result,
        decisionType: "judgment",
      }),
    })),
    scopedDb,
    sourceId: fixture.sourceId,
    sourceLease: lease,
    scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
    readStoredRaw: async () => new TextEncoder().encode(STORED_PAYLOAD),
    bound: { type: "at-most", limit: 10 },
    pageSize: 10,
  });
  if (run.type !== "ran") {
    throw new TypeError("Expected replay to run");
  }
  expect(run.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
  const [row] = await db
    .select({
      decisionType: caseLawDecisions.decisionType,
      version: caseLawDecisions.parserVersion,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, fixture.id));
  expect(row).toEqual({ decisionType: "judgment", version: 4 });
  const [source] = await db
    .select({ order: caseLawSources.observationOrder })
    .from(caseLawSources)
    .where(eq(caseLawSources.id, fixture.sourceId));
  expect(source?.order).toBe(1n);
  await lease.release();
});

test("a row stored under an encoded docket replays to the decoded docket in place", async () => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `replay-apply-${sourceId}`,
    name: "replay apply legacy docket fixture",
  });
  const court = "Okresný súd Bratislava I";
  const legacyPayloadFor = (guid: string | null) =>
    assembleSkCourtsDecision({
      item: { guid, spisovaZnacka: "7C&#x2F;221/1991", sud: { nazov: court } },
      detail: null,
    })?.sourceRaw ?? panic("legacy fixture stores no raw");
  const keyedId = createSafeId<"caseLawDecision">();
  const docketKeyedId = createSafeId<"caseLawDecision">();
  const payloads = new Map([
    [keyedId, legacyPayloadFor("sk-guid-legacy")],
    [docketKeyedId, legacyPayloadFor(null)],
  ]);
  // The legacy key, or the content-addressed one the applied write moves the
  // row to; both name the decision.
  const payloadAt = (key: string) =>
    [...payloads].find(([id]) => key.includes(id))?.[1] ?? panic(key);
  const legacyVersion = PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS] - 1;
  // What an earlier parser wrote: the publisher's encoded docket, verbatim.
  await db.insert(caseLawDecisions).values(
    (
      [
        [keyedId, "sk-guid-legacy"],
        [docketKeyedId, null],
      ] as const
    ).map(([id, sourceDocumentId]) => ({
      id,
      sourceId,
      caseNumber: "7C&#x2F;221/1991",
      court,
      country: "SVK",
      language: "sk",
      sourceDocumentId,
      sourceRawS3Key: `case-law/raw/legacy/${id}`,
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      sourceHash: "hash-before-decoding",
      parserVersion: legacyVersion,
      metadata: {},
    })),
  );
  const lease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId,
  });
  if (lease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }
  const reparse =
    skCourtsAdapter.reparseStoredRaw ?? panic("adapter has no replay reader");
  const replay = async () =>
    await replayCaseLawSource({
      adapter: stubAdapter(reparse),
      scopedDb,
      sourceId,
      sourceLease: lease,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: async (key) =>
        await Promise.resolve(new TextEncoder().encode(payloadAt(key))),
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });
  const readRows = async () => {
    const rows = await db
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        version: caseLawDecisions.parserVersion,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId));
    return Object.fromEntries(
      rows.map(({ id, ...row }) => [String(id), row] as const),
    );
  };

  const first = await replay();
  if (first.type !== "ran") {
    throw new TypeError("Expected replay to run");
  }
  expect(first.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
  // The docket-keyed row has no publisher id the write could find it by, so
  // it is refused rather than inserted again under the new spelling.
  expect(first.report.rejections["identity-mismatch"]).toBe(1);
  expect(await readRows()).toEqual({
    [docketKeyedId]: { caseNumber: "7C&#x2F;221/1991", version: legacyVersion },
    [keyedId]: {
      caseNumber: "7C/221/1991",
      version: PARSER_VERSIONS[ADAPTER_KEYS.SK_COURTS],
    },
  });

  // The migrated row now matches its payload exactly: a second run converges.
  const second = await replay();
  if (second.type !== "ran") {
    throw new TypeError("Expected replay to run");
  }
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);
  expect(second.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
  expect(second.report.rejections["identity-mismatch"]).toBe(1);
  await lease.release();
});

test("registered replay and its pipeline write preserve URLs and cloned diagnostic snapshots", async () => {
  const fixture = await replayConvergenceFixture("Replay URL schema fixture.");
  await db
    .update(caseLawSources)
    .set({ adapterKey: ADAPTER_KEYS.EU_ECJ })
    .where(eq(caseLawSources.id, fixture.sourceId));
  const href = "https://example.test/?stated=&amp;amp;&other=&#x26;";
  const approved = approveMetadataUrls(
    {
      celex: "62026CJ0010",
      manifestationUri: toMetadataUrl(href, "transport-json"),
      languageUri: toMetadataUrl("ftp://example.test/private", "decoded"),
      manifestations: [{ uri: toMetadataUrl(href, "decoded") }],
    },
    EU_ECJ_METADATA_URL_SCHEMA,
  );
  const result = plainTextIngestionResult(
    {
      ...fixture.result,
      rawHash: "replay-url-schema-source-hash",
      metadata: structuredClone(approved),
    },
    EU_ECJ_METADATA_URL_SCHEMA,
  );
  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId: fixture.sourceId,
  });
  if (sourceLease === null) {
    panic("Expected free replay source lease");
  }
  const replay = async () =>
    await replayCaseLawSource({
      adapter: stubAdapter(() => ({ type: "parsed", result })),
      scopedDb,
      sourceId: fixture.sourceId,
      sourceLease,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: async () => new TextEncoder().encode(STORED_PAYLOAD),
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });
  try {
    const first = await replay();
    if (first.type !== "ran") {
      panic("Expected registered replay to run");
    }
    expect(first.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
    const row = (
      await db
        .select({ metadata: caseLawDecisions.metadata })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.id, fixture.id))
        .limit(1)
    ).at(0);
    expect(row?.metadata).toMatchObject({
      manifestationUri: href,
      manifestations: [{ uri: href }],
      metadataUrlDiagnostics: {
        entries: [{ address: "languageUri", reason: "unsafe-protocol" }],
        overflowCount: 0,
      },
    });
    expect(row?.metadata).not.toHaveProperty("languageUri");
    const second = await replay();
    if (second.type !== "ran") {
      panic("Expected repeated replay to run");
    }
    expect(second.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
  } finally {
    await sourceLease.release();
    await db
      .delete(caseLawSources)
      .where(eq(caseLawSources.id, fixture.sourceId));
  }
});

test("replay updates exactly changed rows and produces content-free terminal results", async () => {
  await db.execute(
    sql`CREATE TEMP TABLE replay_decision_updates (decision_id text NOT NULL)`,
  );
  await db.execute(sql`
    CREATE FUNCTION pg_temp.count_replay_decision_update() RETURNS trigger AS $$
    BEGIN
      INSERT INTO replay_decision_updates VALUES (NEW.id::text);
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await db.execute(sql`
    CREATE TRIGGER count_replay_decision_update AFTER UPDATE ON case_law_decisions
    FOR EACH ROW EXECUTE FUNCTION pg_temp.count_replay_decision_update()
  `);
  await assertProperty(
    "replay updates exactly changed rows and produces content-free terminal results",
    fc.asyncProperty(
      fc
        .tuple(
          fc.constant("changed"),
          fc.constant("unchanged"),
          fc.constant("rejected"),
          fc.array(fc.constantFrom("changed", "unchanged", "rejected"), {
            maxLength: 2,
          }),
        )
        .map(([changed, unchanged, rejected, extra]) =>
          [changed, unchanged, rejected].concat(extra),
        ),
      async (kinds) => {
        const fixture = await replayConvergenceFixture(
          "Identical stored body.",
        );
        const results = new Map<string, IngestionResult>();
        const expected: ReplayRowResult[] = [];
        for (const [index, outcome] of kinds.entries()) {
          const caseNumber = `C-${index + 100}/26`;
          const id = createSafeId<"caseLawDecision">();
          const result = plainTextIngestionResult({
            ...fixture.result,
            caseNumber,
          });
          results.set(caseNumber, result);
          await db.insert(caseLawDecisions).values({
            id,
            sourceId: fixture.sourceId,
            caseNumber,
            court: result.court,
            country: result.country,
            language: result.language,
            metadata: result.metadata,
            sourceHash: result.rawHash,
            fulltext:
              outcome === "changed" ? "Old body." : fixture.payload.text,
            sections: fixture.payload.sections,
            documentAst: fixture.payload.ast,
            parserVersion: 3,
            sourceRawS3Key: STORED_KEY_PLACEHOLDER,
          });
          expected.push(
            outcome === "rejected"
              ? {
                  decisionId: id,
                  targetParserVersion: 4,
                  outcome,
                  reason: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
                }
              : { decisionId: id, targetParserVersion: 4, outcome },
          );
        }
        const lease = await acquireCaseLawSourceIngestionLease({
          scopedDb,
          sourceId: fixture.sourceId,
        });
        if (lease === null) {
          panic("Expected free source lease");
        }
        const receipts = new Map<string, ReplayRowResult>();
        const run = async () =>
          await replayCaseLawSource({
            adapter: stubAdapter(({ caseNumber }) => {
              const result = results.get(caseNumber);
              if (result === undefined) {
                return { type: "parsed", result: fixture.result };
              }
              // Rejections are tied to the fixture's input identity, not traversal order.
              const index = kinds.findIndex(
                (_, offset) => caseNumber === `C-${offset + 100}/26`,
              );
              if (kinds.at(index) === "rejected") {
                return {
                  type: "rejected",
                  rejection: STORED_RAW_REPARSE_REJECTION.UNSUPPORTED_CONTENT,
                  detail: "Unsupported fixture payload",
                };
              }
              return { type: "parsed", result };
            }),
            scopedDb,
            sourceId: fixture.sourceId,
            sourceLease: lease,
            scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
            readStoredRaw: async () => new TextEncoder().encode(STORED_PAYLOAD),
            bound: { type: "all" },
            pageSize: 2,
            recordRow: async (report) => {
              const receipt = replayRowResult(report, 4);
              if (receipt === null) {
                panic("Expected terminal fixture result");
              }
              receipts.set(receipt.decisionId, receipt);
            },
          });
        await db.execute(sql`TRUNCATE replay_decision_updates`);
        const first = await run();
        if (first.type !== "ran") {
          panic("Expected replay run");
        }
        expect(first.report.haltReason).toBeNull();
        const updates = await db.execute<{ decision_id: string }>(
          sql`SELECT decision_id FROM replay_decision_updates`,
        );
        expect(
          updates.rows.map(({ decision_id }) => decision_id).toSorted(),
        ).toEqual(
          expected
            .filter(({ outcome }) => outcome === "changed")
            .map(({ decisionId }) => decisionId)
            .toSorted(),
        );
        for (const receipt of expected) {
          expect(receipts.get(receipt.decisionId)).toEqual(receipt);
        }
        expect(receipts.size).toBe(kinds.length + 1);
        await db.execute(sql`TRUNCATE replay_decision_updates`);
        const second = await run();
        if (second.type !== "ran") {
          panic("Expected second replay run");
        }
        expect(second.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);
        expect(
          (await db.execute(sql`SELECT * FROM replay_decision_updates`)).rows,
        ).toHaveLength(0);
        await lease.release();
      },
    ),
    { numRuns: 5 },
  );
  await db.execute(
    sql`DROP TRIGGER count_replay_decision_update ON case_law_decisions`,
  );
});
