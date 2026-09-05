import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import {
  EMPTY_AST,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/handlers/case-law/ingestion/adapter";
import type { SourceAdapter } from "@/api/handlers/case-law/ingestion/adapter";
import {
  CASE_LAW_REPLAY_SCOPE,
  REPLAY_REJECTION_POLICY,
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
} from "@/api/handlers/case-law/ingestion/replay";
import type {
  ReplayCaseLawSourceOptions,
  ReplayRejectionPolicy,
} from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type { DecisionSection } from "@/api/lib/legal-search/document-types";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// A writing replay, through the same `processDecision` a crawl feeds.
//
// Two properties are asserted here that the module cannot state on its own:
// the pipeline really does write the re-parsed payload and clear the search
// projection's staleness marker, and a second run over an unchanged payload
// reaches a fixed point instead of rewriting the row again.
//
// The raw-payload upload runs against an in-process object store, so the
// object itself is the assertion. Its key matters: the pipeline writes that
// key onto the row, so an upload keyed on anything other than the payload's
// own hash would move the row's pointer at the object it names.

let fake: FakeS3;

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
});

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

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

  // The payload the replay read landed under its own content hash, byte for
  // byte, and under the media type the row recorded. A re-parse that returned
  // no payload would otherwise clear the row's pointer to it.
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(STORED_PAYLOAD);
  const contentAddressedKey = `case-law/raw/${sourceId}/${hasher.digest("hex")}`;
  const stored = fake.objects.get(
    `${envBase.S3_BUCKET}/${contentAddressedKey}`,
  );
  expect(new TextDecoder().decode(stored?.bytes)).toBe(STORED_PAYLOAD);
  // The charset parameter is the client's; the media type is the row's, and
  // it is what a later read of this object reports.
  expect(stored?.contentType).toMatch(/^application\/xhtml\+xml\b/u);
  expect(fake.objects.size).toBe(1);

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
    limit: 10,
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
