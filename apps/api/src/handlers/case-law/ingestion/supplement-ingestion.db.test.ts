import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawCitations,
  caseLawDecisionSupplements,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import type {
  DecisionSupplement,
  IngestionResult,
  StoredRawReader,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildPlItem,
  normalizeSaosDumpItem,
  PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
  PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
  plCourtsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import {
  PROCESS_DECISION_STATUS,
  processDecision,
  processSupplement,
  runIngestionPipeline,
  SUPPLEMENT_RETRY_REASON,
} from "@/api/handlers/case-law/ingestion/pipeline";
import { DOCUMENT_SUPPLEMENTS_METADATA_KEY } from "@/api/handlers/case-law/ingestion/supplement-composition";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { ABSORBED_INTO_METADATA_KEY } from "@/api/lib/case-law/decision-absorption";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// Written reasons SAOS publishes apart from their ruling, through the real
// adapter and the real pipeline: the ruling's payload lands in an in-process
// object store, and composing the reasons into it rebuilds the ruling from
// that stored payload, exactly as a production merge does.

/** Ids and citation texts compared as code units, not as words. */
const byCodeUnit = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

let fake: FakeS3;
let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const connect = (pglite: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({
    client: pglite,
    relations: { ...relations, ...authRelationsPart },
  });

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the pipeline expects.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
});

const readStoredRaw: StoredRawReader = async (key) =>
  await Promise.resolve(
    fake.objects.get(`${envBase.S3_BUCKET}/${key}`)?.bytes ?? null,
  );

const reparseStoredRaw =
  plCourtsAdapter.reparseStoredRaw ??
  panic("pl-courts declares no reparseStoredRaw");

const COURT = "Sąd Okręgowy we Wrocławiu";
const DOCKET = "IV Ka 95/18";
/** What only the reasons say, and a decision only the reasons cite. */
const REASONS_TEXT =
  "Apelacja nie zasługiwała na uwzględnienie, jak wskazał Sąd Najwyższy w wyroku z dnia 5 marca 2015 r., sygn. akt V CSK 293/14.";
const RULING_TEXT = "Sąd utrzymuje w mocy zaskarżony wyrok.";

type SaosRowOptions = {
  id: number;
  judgmentType: "SENTENCE" | "DECISION" | "REASONS";
  judgmentDate: string;
  caseNumber?: string;
  body: string;
};

/** One dump row as SAOS lists a common-court judgment with its court. */
const saosRow = ({
  id,
  judgmentType,
  judgmentDate,
  caseNumber = DOCKET,
  body,
}: SaosRowOptions): Record<string, unknown> => ({
  id,
  courtType: "COMMON",
  courtCases: [{ caseNumber }],
  judgmentType,
  judgmentDate,
  judges: [{ name: "Andrzej Szawel", function: null, specialRoles: [] }],
  division: { id: 1083, court: { id: 42, name: COURT } },
  source: {
    code: "COMMON_COURT",
    judgmentId: `152515000002006_${caseNumber.replaceAll(/\W+/gu, "_")}_Uz_${judgmentDate}_${String(id)}`,
  },
  textContent: `<p>Sygn. akt ${caseNumber}</p><div><h2>${
    judgmentType === "REASONS" ? "UZASADNIENIE" : "WYROK"
  }</h2><p>${body}</p></div>`,
});

const itemOf = (row: Record<string, unknown>) =>
  buildPlItem({
    listingItem: normalizeSaosDumpItem(row),
    detail: null,
    rawParts: { "listing-dump": JSON.stringify(row) },
  }) ?? panic("the row built nothing");

const decisionOf = (row: Record<string, unknown>): IngestionResult => {
  const item = itemOf(row);
  return item.type === "decision"
    ? item.decision
    : panic("expected the row to be a decision");
};

const supplementOf = (row: Record<string, unknown>): DecisionSupplement => {
  const item = itemOf(row);
  return item.type === "supplement"
    ? item.supplement
    : panic("expected the row to be a supplement");
};

type Fixture = {
  sourceId: SafeId<"caseLawSource">;
  nextObservationOrder: () => Promise<bigint>;
};

const newSource = async (): Promise<Fixture> => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `${ADAPTER_KEYS.PL_COURTS}-${sourceId}`,
    name: "pl-courts supplement fixture",
  });
  let order = 0n;
  return {
    sourceId,
    nextObservationOrder: async () => {
      order += 1n;
      return await Promise.resolve(order);
    },
  };
};

const ingestDecision = async (
  { sourceId, nextObservationOrder }: Fixture,
  input: IngestionResult,
) => {
  const outcome = await processDecision({
    input,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-23T10:00:00.000Z"),
    observationOrder: await nextObservationOrder(),
  });
  expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  return outcome;
};

const ingestSupplement = async (
  { sourceId, nextObservationOrder }: Fixture,
  supplement: DecisionSupplement,
) =>
  await processSupplement({
    supplement,
    sourceId,
    scopedDb,
    observedAt: new Date("2026-09-23T10:00:00.000Z"),
    nextObservationOrder,
    reparseStoredRaw,
    readStoredRaw,
  });

const decisionRows = async (sourceId: SafeId<"caseLawSource">) =>
  await db
    .select({
      id: caseLawDecisions.id,
      sourceDocumentId: caseLawDecisions.sourceDocumentId,
      decisionType: caseLawDecisions.decisionType,
      fulltext: caseLawDecisions.fulltext,
      sourceHash: caseLawDecisions.sourceHash,
      citationKey: caseLawDecisions.citationKey,
      metadata: caseLawDecisions.metadata,
      updatedAt: caseLawDecisions.updatedAt,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId))
    .orderBy(asc(caseLawDecisions.sourceDocumentId));

const decisionBy = async (
  sourceId: SafeId<"caseLawSource">,
  sourceDocumentId: string,
) =>
  (await decisionRows(sourceId)).find(
    (row) => row.sourceDocumentId === sourceDocumentId,
  ) ?? panic(`no decision ${sourceDocumentId}`);

const publishedIds = async (sourceId: SafeId<"caseLawSource">) =>
  (
    await db
      .select({ sourceDocumentId: caseLawDecisions.sourceDocumentId })
      .from(caseLawDecisions)
      .where(
        and(eq(caseLawDecisions.sourceId, sourceId), publishedCaseLawDecision),
      )
  ).map(({ sourceDocumentId }) => sourceDocumentId);

const citationsOf = async (decisionId: SafeId<"caseLawDecision">) =>
  (
    await db
      .select({ citationText: caseLawCitations.citationText })
      .from(caseLawCitations)
      .where(eq(caseLawCitations.citingDecisionId, decisionId))
  )
    .map(({ citationText }) => citationText)
    .toSorted(byCodeUnit);

const supplementRow = async (
  sourceId: SafeId<"caseLawSource">,
  sourceDocumentId: string,
) =>
  (
    await db
      .select({
        decisionId: caseLawDecisionSupplements.decisionId,
        sourceHash: caseLawDecisionSupplements.sourceHash,
        mergedSourceHash: caseLawDecisionSupplements.mergedSourceHash,
      })
      .from(caseLawDecisionSupplements)
      .where(
        and(
          eq(caseLawDecisionSupplements.sourceId, sourceId),
          eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
        ),
      )
  ).at(0) ?? panic(`no supplement ${sourceDocumentId}`);

const RULING = saosRow({
  id: 339_002,
  judgmentType: "SENTENCE",
  judgmentDate: "2018-03-22",
  body: RULING_TEXT,
});
const REASONS = saosRow({
  id: 339_001,
  judgmentType: "REASONS",
  judgmentDate: "2018-04-19",
  body: REASONS_TEXT,
});

describe("reasons published apart from their ruling", () => {
  test("merge into a ruling already stored, and its citations become the ruling's", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));
    const before = await decisionBy(fixture.sourceId, "339002");
    expect(await citationsOf(before.id)).toEqual([]);

    const placed = await ingestSupplement(fixture, supplementOf(REASONS));

    expect(placed).toEqual({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "merged", judgmentId: before.id },
    });
    // One decision: the ruling, now carrying its reasons.
    const rows = await decisionRows(fixture.sourceId);
    expect(rows.map(({ sourceDocumentId }) => sourceDocumentId)).toEqual([
      "339002",
    ]);
    const ruling = await decisionBy(fixture.sourceId, "339002");
    expect(ruling.id).toBe(before.id);
    expect(ruling.fulltext).toContain(RULING_TEXT);
    expect(ruling.fulltext).toContain(REASONS_TEXT);
    expect(ruling.decisionType).toBe("wyrok");
    expect(ruling.sourceHash).not.toBe(before.sourceHash);
    expect(ruling.metadata?.[DOCUMENT_SUPPLEMENTS_METADATA_KEY]).toEqual([
      expect.objectContaining({ kind: "reasons", sourceDocumentId: "339001" }),
    ]);
    expect(await citationsOf(ruling.id)).toEqual(["sygn. akt V CSK 293/14"]);
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(stored.decisionId).toBe(ruling.id);
    expect(stored.mergedSourceHash).toBe(stored.sourceHash);
  });

  test("arriving before their ruling stand alone, then merge when it arrives", async () => {
    const fixture = await newSource();

    const parked = await ingestSupplement(fixture, supplementOf(REASONS));

    expect(parked).toEqual({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "standalone", reason: "no-judgment" },
    });
    // Readable meanwhile, and typed as what it is.
    const standalone = await decisionBy(fixture.sourceId, "339001");
    expect(standalone.decisionType).toBe(
      PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
    );
    expect(standalone.fulltext).toContain(REASONS_TEXT);
    expect(await citationsOf(standalone.id)).toEqual([
      "sygn. akt V CSK 293/14",
    ]);
    expect(await publishedIds(fixture.sourceId)).toEqual(["339001"]);
    expect((await supplementRow(fixture.sourceId, "339001")).decisionId).toBe(
      null,
    );

    // The ruling's own write composes the parked reasons: no second look at
    // the reasons is needed.
    await ingestDecision(fixture, decisionOf(RULING));

    const ruling = await decisionBy(fixture.sourceId, "339002");
    expect(ruling.fulltext).toContain(REASONS_TEXT);
    expect(await citationsOf(ruling.id)).toEqual(["sygn. akt V CSK 293/14"]);
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(stored.decisionId).toBe(ruling.id);
    expect(stored.mergedSourceHash).toBe(stored.sourceHash);

    // The standalone row is absorbed: kept, unpublished, and no longer a
    // second holder of the docket or a second copy of the citations.
    const absorbed = await decisionBy(fixture.sourceId, "339001");
    expect(absorbed.id).toBe(standalone.id);
    expect(absorbed.fulltext).toBeNull();
    expect(absorbed.citationKey).toBeNull();
    expect(absorbed.metadata?.[ABSORBED_INTO_METADATA_KEY]).toEqual({
      decisionId: ruling.id,
      kind: "reasons",
      sourceDocumentId: "339001",
    });
    expect(await citationsOf(absorbed.id)).toEqual([]);
    expect(await publishedIds(fixture.sourceId)).toEqual(["339002"]);
  });

  test("ingesting the same reasons or the same ruling again is a fixed point", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));
    await ingestSupplement(fixture, supplementOf(REASONS));
    const snapshot = async () => ({
      rows: await decisionRows(fixture.sourceId),
      citations: await citationsOf(
        (await decisionBy(fixture.sourceId, "339002")).id,
      ),
      supplement: await supplementRow(fixture.sourceId, "339001"),
      objects: [...fake.objects.keys()].toSorted(byCodeUnit),
    });
    const merged = await snapshot();

    const again = await ingestSupplement(fixture, supplementOf(REASONS));
    expect(again.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
    expect(await snapshot()).toEqual(merged);

    const reobserved = await ingestDecision(fixture, decisionOf(RULING));
    expect(reobserved).toMatchObject({ inserted: false });
    expect(await snapshot()).toEqual(merged);
  });

  test("an edited version of the reasons replaces the one the ruling holds", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));
    await ingestSupplement(fixture, supplementOf(REASONS));

    const edited = "Sprostowane uzasadnienie, powołujące III KK 195/16.";
    await ingestSupplement(
      fixture,
      supplementOf(
        saosRow({
          id: 339_001,
          judgmentType: "REASONS",
          judgmentDate: "2018-04-19",
          body: edited,
        }),
      ),
    );

    const ruling = await decisionBy(fixture.sourceId, "339002");
    expect(ruling.fulltext).toContain(edited);
    expect(ruling.fulltext).not.toContain(REASONS_TEXT);
    expect(await citationsOf(ruling.id)).toEqual(["III KK 195/16"]);
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(stored.mergedSourceHash).toBe(stored.sourceHash);
  });

  test("reasons dated before the only ruling under their docket do not join it", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));

    const placed = await ingestSupplement(
      fixture,
      supplementOf(
        saosRow({
          id: 339_001,
          judgmentType: "REASONS",
          judgmentDate: "2018-01-05",
          body: REASONS_TEXT,
        }),
      ),
    );

    expect(placed).toEqual({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "standalone", reason: "no-judgment" },
    });
    expect(
      (await decisionBy(fixture.sourceId, "339002")).fulltext,
    ).not.toContain(REASONS_TEXT);
  });
});

/**
 * The reasons stored as a decision of their own beside a stored ruling, as
 * every row stored before supplements existed is.
 */
const ingestStandaloneReasons = async (fixture: Fixture) => {
  const { document } = supplementOf(REASONS);
  return await ingestDecision(fixture, {
    ...document,
    decisionType: PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
    metadata: {
      ...document.metadata,
      decisionType: PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
    },
  });
};

describe("the standalone row of reasons already stored", () => {
  test("is taken down with a redacted ruling", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));
    const ruling = await decisionBy(fixture.sourceId, "339002");
    await db
      .update(caseLawDecisions)
      // A takedown erases the payload with it.
      .set({
        redactedAt: new Date("2026-09-23T09:00:00.000Z"),
        contentHash: null,
        documentAst: null,
        fulltext: null,
        sections: null,
      })
      .where(eq(caseLawDecisions.id, ruling.id));
    await ingestStandaloneReasons(fixture);
    expect(await publishedIds(fixture.sourceId)).toContain("339001");

    const placed = await ingestSupplement(fixture, supplementOf(REASONS));

    expect(placed).toEqual({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "withheld", judgmentId: ruling.id },
    });
    expect(await publishedIds(fixture.sourceId)).not.toContain("339001");
    const standalone = await decisionBy(fixture.sourceId, "339001");
    expect(standalone.fulltext).toBeNull();
    expect(await citationsOf(standalone.id)).toEqual([]);
  });

  test("holds the placement until it is absorbed, then converges", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));
    // The ruling holds the reasons, and their standalone row still stands:
    // the state an absorption that failed after the merge leaves.
    await ingestSupplement(fixture, supplementOf(REASONS));
    await ingestStandaloneReasons(fixture);
    const standalone = await decisionBy(fixture.sourceId, "339001");
    const place = async (
      absorb?: Parameters<typeof processSupplement>[0]["absorb"],
    ) =>
      await processSupplement({
        supplement: supplementOf(REASONS),
        sourceId: fixture.sourceId,
        scopedDb,
        observedAt: new Date("2026-09-23T10:00:00.000Z"),
        nextObservationOrder: fixture.nextObservationOrder,
        reparseStoredRaw,
        readStoredRaw,
        ...(absorb === undefined ? {} : { absorb }),
      });

    // A corpus object outlived its delete: the row keeps its document.
    const held = await place(
      async () =>
        await Promise.resolve(
          Result.ok({
            type: "withdraw-incomplete" as const,
            decisionId: standalone.id,
          }),
        ),
    );

    expect(held).toEqual({
      status: PROCESS_DECISION_STATUS.RETRYABLE,
      reason: SUPPLEMENT_RETRY_REASON.ABSORB,
    });
    expect(await publishedIds(fixture.sourceId)).toContain("339001");

    const ruling = await decisionBy(fixture.sourceId, "339002");
    expect(await place()).toEqual({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "merged", judgmentId: ruling.id },
    });
    expect(await publishedIds(fixture.sourceId)).toEqual(["339002"]);
  });
});

test("reasons a correction moves to another docket leave their former ruling for the new one", async () => {
  const fixture = await newSource();
  const OTHER_DOCKET = "IV Ka 96/18";
  await ingestDecision(fixture, decisionOf(RULING));
  await ingestDecision(
    fixture,
    decisionOf(
      saosRow({
        id: 339_003,
        judgmentType: "SENTENCE",
        judgmentDate: "2018-03-22",
        caseNumber: OTHER_DOCKET,
        body: RULING_TEXT,
      }),
    ),
  );
  await ingestSupplement(fixture, supplementOf(REASONS));
  const former = await decisionBy(fixture.sourceId, "339002");
  expect(former.fulltext).toContain(REASONS_TEXT);

  const placed = await ingestSupplement(
    fixture,
    supplementOf(
      saosRow({
        id: 339_001,
        judgmentType: "REASONS",
        judgmentDate: "2018-04-19",
        caseNumber: OTHER_DOCKET,
        body: REASONS_TEXT,
      }),
    ),
  );

  const corrected = await decisionBy(fixture.sourceId, "339003");
  expect(placed).toEqual({
    status: PROCESS_DECISION_STATUS.COMPLETE,
    disposition: { type: "merged", judgmentId: corrected.id },
  });
  expect(corrected.fulltext).toContain(REASONS_TEXT);
  expect((await decisionBy(fixture.sourceId, "339002")).fulltext).not.toContain(
    REASONS_TEXT,
  );
  expect((await supplementRow(fixture.sourceId, "339001")).decisionId).toBe(
    corrected.id,
  );
});

test("reasons parked while their ruling is being written are composed by that write", async () => {
  const fixture = await newSource();
  const reasons = supplementOf(REASONS);
  // Parks the reasons between the ruling's composition read and its row
  // write, as a concurrent ingest of the reasons would.
  let transactions = 0;
  const racingDb: ScopedDb = async (work) => {
    transactions += 1;
    if (transactions === 2) {
      await db.insert(caseLawDecisionSupplements).values({
        sourceId: fixture.sourceId,
        sourceDocumentId: reasons.document.sourceDocumentId,
        kind: reasons.kind,
        caseNumber: reasons.document.caseNumber,
        court: reasons.document.court,
        language: reasons.document.language,
        latestDecisionDate: reasons.target.latestDecisionDate ?? null,
        judgmentDecisionTypes: [...reasons.target.decisionTypes],
        fulltext: reasons.document.fulltext ?? null,
        documentAst: reasons.document.documentAst,
        sourceHash: reasons.document.rawHash,
        metadata: reasons.document.metadata,
        observedAt: new Date("2026-09-23T10:00:00.000Z"),
      });
    }
    return await scopedDb(work);
  };

  const outcome = await processDecision({
    input: decisionOf(RULING),
    sourceId: fixture.sourceId,
    scopedDb: racingDb,
    observedAt: new Date("2026-09-23T10:00:00.000Z"),
    observationOrder: await fixture.nextObservationOrder(),
  });

  expect(outcome.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  const ruling = await decisionBy(fixture.sourceId, "339002");
  expect(ruling.fulltext).toContain(REASONS_TEXT);
  expect((await supplementRow(fixture.sourceId, "339001")).decisionId).toBe(
    ruling.id,
  );
});

test("the crawl places a page's reasons after its decisions, from the payload it just stored", async () => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: ADAPTER_KEYS.PL_COURTS,
    name: "pl-courts crawl fixture",
  });
  const source =
    (
      await db
        .select()
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
    ).at(0) ?? panic("the source row is gone");
  const sourceLease =
    (await acquireCaseLawSourceIngestionLease({ scopedDb, sourceId })) ??
    panic("expected the source lease to be free");
  const originalFetchPage = plCourtsAdapter.fetchPage;
  // The page lists the reasons ahead of their ruling, as the dump's id order
  // often does; the pipeline places supplements once the decisions are in.
  plCourtsAdapter.fetchPage = async () =>
    await Promise.resolve(
      Result.ok({
        decisions: [decisionOf(RULING)],
        supplements: [supplementOf(REASONS)],
        nextCursor: null,
      }),
    );
  try {
    const run = await runIngestionPipeline({
      source,
      sourceLease,
      scopedDb,
      maxPages: 1,
    });
    expect(run.haltReason).toBeNull();
  } finally {
    plCourtsAdapter.fetchPage = originalFetchPage;
    await sourceLease.release();
  }

  const rows = await decisionRows(sourceId);
  expect(rows.map(({ sourceDocumentId }) => sourceDocumentId)).toEqual([
    "339002",
  ]);
  expect(rows.at(0)?.fulltext).toContain(REASONS_TEXT);
  expect((await supplementRow(sourceId, "339001")).decisionId).toBe(
    rows.at(0)?.id ?? null,
  );
});
