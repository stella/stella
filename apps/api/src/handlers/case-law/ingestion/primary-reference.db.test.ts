/**
 * A decision's primary reference, through every writer that persists it.
 *
 * `case_number` holds the primary citable reference and a persisted type
 * says what kind it is. The crawl, a refresh that changes the kind, a replay
 * of the stored payload and the identifier backfill must all leave the same
 * row: one id and slug, the typed identifiers, the docket kept beside a
 * reporter primary, and a legacy docket key only where the primary is a
 * docket. A docket-primary decision of an existing jurisdiction must come out
 * exactly as it did before the type existed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import type {
  IngestionResult,
  SourceAdapter,
  StoredRawReparseInput,
} from "@/api/handlers/case-law/ingestion/adapter";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import {
  citationKeyOf,
  decisionIdentifiersFromStoredMetadata,
} from "@/api/handlers/case-law/ingestion/citation-extractor";
import { runDecisionIdentifierBackfill } from "@/api/handlers/case-law/ingestion/decision-identifier-backfill";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { CaseLawCorpusDependencies } from "@/api/handlers/case-law/ingestion/pipeline/dependencies";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import {
  CASE_LAW_REPLAY_SCOPE,
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
} from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;
let scopedDb: ScopedDb;

// PGlite and Bun SQL expose the same transaction/execute surface the
// backfill consumes.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural test adapter across Drizzle drivers
const rootDb = () => db as unknown as CaseLawRootHandle;

const postgresOnly = {
  mode: "off",
  transfer: {
    layout: "packs",
    putPacks: () => {
      throw new TypeError("a postgres-only plan must not transfer packs");
    },
  },
} satisfies CaseLawCorpusDependencies;

const REPORTER = "347 U.S. 483";
const DOCKET = "No. 1";
const SCOTUS = "Supreme Court of the United States";

const base = {
  decisionDate: "1954-05-17",
  documentAst: EMPTY_AST,
  fulltext: "Opinion of the Court.",
  textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
} as const;

const czechDecision = (rawHash: string): IngestionResult => ({
  ...base,
  caseNumber: "21 Cdo 1234/2020",
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  metadata: { chamber: "21" },
  rawHash,
  sourceDocumentId: "cz-1",
});

const usDocketDecision = (sourceDocumentId: string): IngestionResult => ({
  ...base,
  caseNumber: DOCKET,
  court: SCOTUS,
  country: "USA",
  language: "en",
  metadata: {},
  rawHash: `docket-${sourceDocumentId}`,
  sourceDocumentId,
});

const usReporterDecision = (sourceDocumentId: string): IngestionResult => ({
  ...usDocketDecision(sourceDocumentId),
  caseNumber: REPORTER,
  caseNumberType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  identifiers: [{ type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: DOCKET }],
  rawHash: `reporter-${sourceDocumentId}`,
});

let order = 0n;
const ingest = async (
  sourceId: SafeId<"caseLawSource">,
  input: IngestionResult,
) => {
  order += 1n;
  const outcome = await processDecision({
    input,
    observationOrder: order,
    sourceId,
    scopedDb,
    observedAt: new Date(Date.UTC(2026, 8, 26, 12, 0, Number(order))),
    corpus: postgresOnly,
  });
  expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
};

const newSource = async (): Promise<SafeId<"caseLawSource">> => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `primary-reference-${sourceId}`,
    name: "Primary reference test",
  });
  return sourceId;
};

/** A fixed order to compare an unordered identifier set by. */
const byTypeThenValue = (
  left: { type: string; value: string },
  right: { type: string; value: string },
): number => {
  const leftKey = `${left.type}\u0000${left.value}`;
  const rightKey = `${right.type}\u0000${right.value}`;
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
};

const storedDecision = async (
  sourceId: SafeId<"caseLawSource">,
  sourceDocumentId: string,
) => {
  const row = (
    await db
      .select({
        id: caseLawDecisions.id,
        caseNumber: caseLawDecisions.caseNumber,
        caseNumberType: caseLawDecisions.caseNumberType,
        citationKey: caseLawDecisions.citationKey,
        country: caseLawDecisions.country,
        ecli: caseLawDecisions.ecli,
        languageGroupKey: caseLawDecisions.languageGroupKey,
        metadata: caseLawDecisions.metadata,
        slug: caseLawDecisions.slug,
      })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, sourceId),
          eq(caseLawDecisions.sourceDocumentId, sourceDocumentId),
        ),
      )
  ).at(0);
  if (row === undefined) {
    throw new TypeError(`expected a stored decision ${sourceDocumentId}`);
  }
  const identifiers = await db
    .select({
      type: caseLawDecisionIdentifiers.type,
      value: caseLawDecisionIdentifiers.value,
    })
    .from(caseLawDecisionIdentifiers)
    .where(eq(caseLawDecisionIdentifiers.decisionId, row.id))
    .orderBy(
      asc(caseLawDecisionIdentifiers.type),
      asc(caseLawDecisionIdentifiers.value),
    );
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  return {
    ...row,
    metadata,
    identifiers,
    // What every reader that has no identifier rows recovers from the row.
    recovered: [
      ...decisionIdentifiersFromStoredMetadata({
        caseNumber: row.caseNumber,
        caseNumberType: row.caseNumberType,
        ecli: row.ecli,
        jurisdiction: row.country,
        metadata,
      }),
    ].toSorted(byTypeThenValue),
    sourceId,
  };
};

const REPORTER_IDENTIFIERS = [
  { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: DOCKET },
  { type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION, value: REPORTER },
];

/**
 * A replay of one stored decision through a parser that returns `parse`.
 *
 * The row gets a stored payload to read, which the crawl did not store, and
 * an observation order below the replay's own: this file's crawl numbers
 * observations itself rather than through the source's allocator, which the
 * replay draws from.
 */
const replayerFor = async (
  row: { id: SafeId<"caseLawDecision">; sourceId: SafeId<"caseLawSource"> },
  parse: (stored: StoredRawReparseInput) => IngestionResult,
) => {
  await db
    .update(caseLawDecisions)
    .set({
      sourceObservationOrder: 0n,
      sourceRawS3Key: `case-law/raw/legacy/${row.id}`,
      sourceRawContentType: "application/json",
    })
    .where(eq(caseLawDecisions.id, row.id));
  const adapter: SourceAdapter = {
    key: ADAPTER_KEYS.EU_ECJ,
    sourceFields: {
      status: "declared",
      fields: {},
      listSourceFields: () => [],
    },
    sourceSurfaces: { surfaces: {} },
    name: "primary reference replay stub",
    country: "USA",
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
    reparseStoredRaw: (stored) => ({ type: "parsed", result: parse(stored) }),
  };
  const sourceLease = await acquireCaseLawSourceIngestionLease({
    scopedDb,
    sourceId: row.sourceId,
  });
  if (sourceLease === null) {
    throw new TypeError("Expected the source ingestion lease to be free");
  }
  const replay = async () => {
    const run = await replayCaseLawSource({
      adapter,
      scopedDb,
      sourceId: row.sourceId,
      scope: CASE_LAW_REPLAY_SCOPE.SOURCE,
      readStoredRaw: async () =>
        await Promise.resolve(new TextEncoder().encode("{}")),
      sourceLease,
      bound: { type: "at-most", limit: 10 },
      pageSize: 10,
    });
    if (run.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    return run;
  };
  return { replay, release: async () => await sourceLease.release() };
};

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
}, 120_000);

afterAll(async () => {
  await client.close();
});

test("a docket primary of an existing jurisdiction is stored as it always was", async () => {
  const sourceId = await newSource();
  await ingest(sourceId, czechDecision("cz-v1"));
  const first = await storedDecision(sourceId, "cz-1");

  expect(first.citationKey).toBe(citationKeyOf("21 Cdo 1234/2020"));
  expect(first.languageGroupKey).toBe(`${sourceId}:21 Cdo 1234/2020`);
  expect(first.caseNumberType).toBe(DECISION_IDENTIFIER_TYPES.CASE_NUMBER);
  expect(first.metadata).toEqual({ chamber: "21" });
  expect(first.identifiers).toEqual([
    {
      type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      value: "21 Cdo 1234/2020",
    },
  ]);
  expect(first.recovered).toEqual(first.identifiers);

  await ingest(sourceId, czechDecision("cz-v2"));
  const refreshed = await storedDecision(sourceId, "cz-1");
  expect(refreshed.id).toBe(first.id);
  expect(refreshed.slug).toBe(first.slug);
  expect(refreshed.citationKey).toBe(first.citationKey);
  expect(refreshed.languageGroupKey).toBe(first.languageGroupKey);
  expect(refreshed.identifiers).toEqual(first.identifiers);
});

test("a reporter primary keeps its docket as an identifier and no docket key", async () => {
  const sourceId = await newSource();
  await ingest(sourceId, usReporterDecision("cluster-1"));
  const stored = await storedDecision(sourceId, "cluster-1");

  expect(stored.caseNumber).toBe(REPORTER);
  expect(stored.citationKey).toBeNull();
  expect(stored.languageGroupKey).toBe(`${sourceId}:document:cluster-1`);
  expect(stored.caseNumberType).toBe(
    DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  );
  expect(stored.identifiers).toEqual(REPORTER_IDENTIFIERS);
  // The stored recovery reads the same typed set, not a docket built from
  // the reporter citation.
  expect(stored.recovered).toEqual(REPORTER_IDENTIFIERS);
});

test("a docket upgraded to a reporter primary keeps the row and drops its docket key", async () => {
  const sourceId = await newSource();
  await ingest(sourceId, usDocketDecision("cluster-2"));
  const docket = await storedDecision(sourceId, "cluster-2");
  // The fixture reaches the fault: a docket primary does carry a key.
  expect(docket.citationKey).toBe(citationKeyOf(DOCKET));

  await ingest(sourceId, usReporterDecision("cluster-2"));
  const upgraded = await storedDecision(sourceId, "cluster-2");

  expect(upgraded.id).toBe(docket.id);
  expect(upgraded.slug).toBe(docket.slug);
  expect(upgraded.languageGroupKey).toBe(docket.languageGroupKey);
  expect(upgraded.caseNumber).toBe(REPORTER);
  expect(upgraded.caseNumberType).toBe(
    DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  );
  expect(upgraded.citationKey).toBeNull();
  expect(upgraded.identifiers).toEqual(REPORTER_IDENTIFIERS);
});

test("a replay upgrading a docket primary to its reporter citation, the backfill and a second replay converge", async () => {
  const fake = startFakeS3();
  try {
    const sourceId = await newSource();
    // Written by a parser that took the docket as the primary.
    await ingest(sourceId, usDocketDecision("cluster-3"));
    const crawled = await storedDecision(sourceId, "cluster-3");
    expect(crawled.caseNumber).toBe(DOCKET);
    expect(crawled.citationKey).toBe(citationKeyOf(DOCKET));
    const { replay, release } = await replayerFor(crawled, (stored) => ({
      ...usReporterDecision(stored.sourceDocumentId ?? ""),
      rawHash: "current-parser",
    }));

    const first = await replay();
    if (first.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    // The reference changed and the document did not: the same decision,
    // written again, not an identity mismatch.
    expect(first.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
    const replayed = await storedDecision(sourceId, "cluster-3");
    expect(replayed.id).toBe(crawled.id);
    expect(replayed.slug).toBe(crawled.slug);
    expect(replayed.languageGroupKey).toBe(crawled.languageGroupKey);
    expect(replayed.caseNumber).toBe(REPORTER);
    expect(replayed.caseNumberType).toBe(
      DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    );
    expect(replayed.citationKey).toBeNull();
    expect(replayed.identifiers).toEqual(REPORTER_IDENTIFIERS);
    expect(replayed.recovered).toEqual(REPORTER_IDENTIFIERS);

    // The global backfill reprojects every decision from its stored
    // columns and metadata, the rows of the tests above included, and finds
    // nothing to rewrite.
    const identifierRows = async () =>
      await db
        .select({
          decisionId: caseLawDecisionIdentifiers.decisionId,
          type: caseLawDecisionIdentifiers.type,
          value: caseLawDecisionIdentifiers.value,
        })
        .from(caseLawDecisionIdentifiers)
        .orderBy(
          asc(caseLawDecisionIdentifiers.decisionId),
          asc(caseLawDecisionIdentifiers.type),
          asc(caseLawDecisionIdentifiers.value),
        );
    const before = await identifierRows();
    const backfill = await runDecisionIdentifierBackfill(rootDb());
    expect(backfill.verification.gaps.decisionIdentifierMismatches).toBe(0);
    expect(await identifierRows()).toEqual(before);

    const second = await replay();
    if (second.type !== "ran") {
      throw new TypeError("Expected the capable adapter to run");
    }
    expect(second.report.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
    expect(await storedDecision(sourceId, "cluster-3")).toEqual(replayed);
    await release();
  } finally {
    fake.stop();
  }
});

test("a correction of the reference type alone is written under an unchanged source hash", async () => {
  const sourceId = await newSource();
  // A reporter citation first stored as though it were a docket.
  const mistyped = {
    ...usDocketDecision("cluster-4"),
    caseNumber: REPORTER,
    rawHash: "same-payload",
  };
  await ingest(sourceId, mistyped);
  const before = await storedDecision(sourceId, "cluster-4");
  expect(before.caseNumberType).toBe(DECISION_IDENTIFIER_TYPES.CASE_NUMBER);
  expect(before.citationKey).toBe(citationKeyOf(REPORTER));

  await ingest(sourceId, {
    ...mistyped,
    caseNumberType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  });
  const corrected = await storedDecision(sourceId, "cluster-4");

  expect(corrected.id).toBe(before.id);
  expect(corrected.slug).toBe(before.slug);
  expect(corrected.caseNumberType).toBe(
    DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
  );
  expect(corrected.citationKey).toBeNull();
  expect(corrected.identifiers).toEqual([
    { type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION, value: REPORTER },
  ]);
});

test("two spellings of one reporter citation become one identifier row", async () => {
  const sourceId = await newSource();
  // `A.` and `Atl.` name one reporter, so the two keys are one.
  await ingest(sourceId, {
    ...usDocketDecision("cluster-5"),
    caseNumber: "10 A. 5",
    caseNumberType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    identifiers: [
      { type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION, value: "10 Atl. 5" },
    ],
  });
  const stored = await storedDecision(sourceId, "cluster-5");

  // The primary's spelling is the row; the other stays in the stored
  // publisher identifiers.
  expect(stored.identifiers).toEqual([
    { type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION, value: "10 A. 5" },
  ]);
  expect(stored.recovered).toEqual(stored.identifiers);
  expect(stored.metadata["_stellaDecisionIdentifiers"]).toEqual([
    { type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION, value: "10 Atl. 5" },
  ]);

  const backfill = await runDecisionIdentifierBackfill(rootDb());
  expect(backfill.verification.gaps.decisionIdentifierMismatches).toBe(0);
  expect((await storedDecision(sourceId, "cluster-5")).identifiers).toEqual(
    stored.identifiers,
  );
});

test("a replay correcting only the reference type is applied", async () => {
  const fake = startFakeS3();
  try {
    const sourceId = await newSource();
    const mistyped = {
      ...usDocketDecision("cluster-6"),
      caseNumber: REPORTER,
      rawHash: "same-payload",
    };
    await ingest(sourceId, mistyped);
    const before = await storedDecision(sourceId, "cluster-6");
    const { replay, release } = await replayerFor(before, () => ({
      ...mistyped,
      caseNumberType: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    }));

    const run = await replay();
    await release();

    expect(run.report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
    const corrected = await storedDecision(sourceId, "cluster-6");
    expect(corrected.id).toBe(before.id);
    expect(corrected.caseNumberType).toBe(
      DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    );
    expect(corrected.citationKey).toBeNull();
  } finally {
    fake.stop();
  }
});
