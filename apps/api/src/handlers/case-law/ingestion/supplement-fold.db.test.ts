import { panic, Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
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
  IngestionResult,
  StoredRawResultReader,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  buildPlItem,
  normalizeSaosDumpItem,
  PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
  PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
  plCourtsAdapter,
} from "@/api/handlers/case-law/ingestion/adapters/pl-courts";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import { PROCESS_DECISION_STATUS } from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { allocateSourceObservationOrder } from "@/api/handlers/case-law/ingestion/pipeline/source-observation";
import {
  foldStoredSupplements,
  SUPPLEMENT_FOLD_OUTCOME,
} from "@/api/handlers/case-law/ingestion/supplement-fold";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { ABSORBED_INTO_METADATA_KEY } from "@/api/lib/case-law/decision-absorption";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// The fold over reasons rows stored as decisions before supplements existed,
// seeded with the shapes the corpus holds: reasons dated with their ruling,
// reasons written weeks after it, a docket holding an order and a judgment,
// and reasons whose ruling the corpus never received.

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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
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

const readStoredRaw: StoredRawResultReader = async (key) =>
  await Promise.resolve(
    Result.ok(fake.objects.get(`${envBase.S3_BUCKET}/${key}`)?.bytes ?? null),
  );

const COURT = "Sąd Okręgowy we Wrocławiu";
const OTHER_COURT = "Sąd Rejonowy dla Wrocławia-Krzyków";

type SaosRowOptions = {
  id: number;
  judgmentType: "SENTENCE" | "DECISION" | "REASONS";
  judgmentDate: string;
  caseNumber: string;
  court?: string;
  body: string;
};

const saosRow = ({
  id,
  judgmentType,
  judgmentDate,
  caseNumber,
  court = COURT,
  body,
}: SaosRowOptions): Record<string, unknown> => ({
  id,
  courtType: "COMMON",
  courtCases: [{ caseNumber }],
  judgmentType,
  judgmentDate,
  division: { id: 1083, court: { id: 42, name: court } },
  source: {
    code: "COMMON_COURT",
    judgmentId: `1525_${caseNumber.replaceAll(/\W+/gu, "_")}_Uz_${judgmentDate}_${String(id)}`,
  },
  textContent: `<p>Sygn. akt ${caseNumber}</p><div><h2>${
    judgmentType === "REASONS" ? "UZASADNIENIE" : "WYROK"
  }</h2><p>${body}</p></div>`,
});

const builtFrom = (row: Record<string, unknown>) =>
  buildPlItem({
    listingItem: normalizeSaosDumpItem(row),
    detail: null,
    rawParts: { "listing-dump": JSON.stringify(row) },
  }) ?? panic("the row built nothing");

/** A ruling, stored as the crawl stores one. */
const rulingInput = (row: Record<string, unknown>): IngestionResult => {
  const built = builtFrom(row);
  return built.type === "decision"
    ? built.decision
    : panic("expected a ruling");
};

/**
 * A reasons row as the adapter stored it before supplements: a decision of
 * type `uzasadnienie`, with the same payload archived beside it.
 */
const legacyReasonsInput = (row: Record<string, unknown>): IngestionResult => {
  const built = builtFrom(row);
  if (built.type !== "supplement") {
    return panic("expected reasons");
  }
  const { document } = built.supplement;
  return {
    ...document,
    decisionType: PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
    metadata: {
      ...document.metadata,
      decisionType: PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
    },
  };
};

const SEED = {
  sameDayRuling: saosRow({
    id: 1002,
    judgmentType: "SENTENCE",
    judgmentDate: "2018-03-22",
    caseNumber: "IV Ka 95/18",
    body: "Sąd utrzymuje w mocy zaskarżony wyrok.",
  }),
  sameDayReasons: saosRow({
    id: 1001,
    judgmentType: "REASONS",
    judgmentDate: "2018-03-22",
    caseNumber: "IV Ka 95/18",
    body: "Uzasadnienie tego samego dnia, powołujące III KK 195/16.",
  }),
  laterRuling: saosRow({
    id: 2001,
    judgmentType: "SENTENCE",
    judgmentDate: "2018-03-01",
    caseNumber: "II C 190/17",
    body: "Sąd zasądza od pozwanego kwotę.",
  }),
  laterReasons: saosRow({
    id: 2002,
    judgmentType: "REASONS",
    judgmentDate: "2018-04-10",
    caseNumber: "II C 190/17",
    body: "Uzasadnienie spisane później, sygn. akt V CSK 293/14.",
  }),
  // The same docket at another court: never a sibling.
  otherCourtRuling: saosRow({
    id: 2501,
    judgmentType: "SENTENCE",
    judgmentDate: "2018-03-01",
    caseNumber: "II C 190/17",
    court: OTHER_COURT,
    body: "Inny sąd, ta sama sygnatura.",
  }),
  order: saosRow({
    id: 3001,
    judgmentType: "DECISION",
    judgmentDate: "2018-01-10",
    caseNumber: "I Ns 840/17",
    body: "Sąd postanawia odrzucić wniosek.",
  }),
  judgment: saosRow({
    id: 3002,
    judgmentType: "SENTENCE",
    judgmentDate: "2018-03-01",
    caseNumber: "I Ns 840/17",
    body: "Sąd orzeka co do istoty sprawy.",
  }),
  reasonsOfJudgment: saosRow({
    id: 3003,
    judgmentType: "REASONS",
    judgmentDate: "2018-04-10",
    caseNumber: "I Ns 840/17",
    body: "Uzasadnienie wyroku, sygn. akt II K 494/17.",
  }),
  reasonsOfOrder: saosRow({
    id: 3004,
    judgmentType: "REASONS",
    judgmentDate: "2018-02-01",
    caseNumber: "I Ns 840/17",
    body: "Uzasadnienie postanowienia.",
  }),
  orphanReasons: saosRow({
    id: 4001,
    judgmentType: "REASONS",
    judgmentDate: "2018-05-05",
    caseNumber: "X C 3694/17",
    body: "Uzasadnienie bez orzeczenia w korpusie, sygn. akt V CSK 293/14.",
  }),
} as const;

const RULINGS = [
  SEED.sameDayRuling,
  SEED.laterRuling,
  SEED.otherCourtRuling,
  SEED.order,
  SEED.judgment,
];
const LEGACY_REASONS = [
  SEED.sameDayReasons,
  SEED.laterReasons,
  SEED.reasonsOfJudgment,
  SEED.reasonsOfOrder,
  SEED.orphanReasons,
];

const rows = async (sourceId: SafeId<"caseLawSource">) =>
  await db
    .select({
      id: caseLawDecisions.id,
      sourceDocumentId: caseLawDecisions.sourceDocumentId,
      decisionType: caseLawDecisions.decisionType,
      fulltext: caseLawDecisions.fulltext,
      citationKey: caseLawDecisions.citationKey,
      metadata: caseLawDecisions.metadata,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId))
    .orderBy(asc(caseLawDecisions.sourceDocumentId));

const rowOf = async (sourceId: SafeId<"caseLawSource">, saosId: number) =>
  (await rows(sourceId)).find(
    ({ sourceDocumentId }) => sourceDocumentId === String(saosId),
  ) ?? panic(`no row ${saosId}`);

const citationsOf = async (decisionId: SafeId<"caseLawDecision">) =>
  (
    await db
      .select({ citationText: caseLawCitations.citationText })
      .from(caseLawCitations)
      .where(eq(caseLawCitations.citingDecisionId, decisionId))
  )
    .map(({ citationText }) => citationText)
    .toSorted(byCodeUnit);

test("the fold merges every reasons row into the ruling it explains and keeps the rest standing", async () => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `${ADAPTER_KEYS.PL_COURTS}-${sourceId}`,
    name: "pl-courts fold fixture",
  });
  const sourceLease =
    (await acquireCaseLawSourceIngestionLease({ scopedDb, sourceId })) ??
    panic("expected the source lease to be free");
  // Seeded on the source's own counter, as the crawl wrote them: the fold's
  // writes are ordered after these.
  for (const input of [
    ...RULINGS.map(rulingInput),
    ...LEGACY_REASONS.map(legacyReasonsInput),
  ]) {
    const seeded = await processDecision({
      input,
      sourceId,
      scopedDb,
      observedAt: new Date("2026-09-01T00:00:00.000Z"),
      observationOrder: await allocateSourceObservationOrder({
        leaseToken: sourceLease.leaseToken,
        scopedDb,
        sourceId,
      }),
    });
    expect(seeded.status).toBe(PROCESS_DECISION_STATUS.COMPLETE);
  }

  // What the corpus looks like before: every reasons document a decision of
  // its own, carrying the citations its text makes.
  const legacyBefore = await rowOf(sourceId, 2002);
  expect(legacyBefore.decisionType).toBe(
    PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
  );
  expect(await citationsOf(legacyBefore.id)).toEqual([
    "sygn. akt V CSK 293/14",
  ]);

  const fold = async () =>
    await foldStoredSupplements({
      scopedDb,
      sourceId,
      adapter: plCourtsAdapter,
      readStoredRaw,
      sourceLease,
      decisionTypes: [PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE],
      limit: 100,
      pageSize: 2,
    });

  const report = await fold();

  expect(report.haltReason).toBeNull();
  expect(report.visited).toBe(LEGACY_REASONS.length);
  expect(report.outcomes).toMatchObject({
    [SUPPLEMENT_FOLD_OUTCOME.MERGED]: 4,
    [SUPPLEMENT_FOLD_OUTCOME.STANDALONE]: 1,
    [SUPPLEMENT_FOLD_OUTCOME.RETRYABLE]: 0,
  });

  // Each reasons document joined the ruling it explains.
  const expectations = [
    { reasons: 1001, ruling: 1002, text: "Uzasadnienie tego samego dnia" },
    { reasons: 2002, ruling: 2001, text: "Uzasadnienie spisane później" },
    { reasons: 3003, ruling: 3002, text: "Uzasadnienie wyroku" },
    { reasons: 3004, ruling: 3001, text: "Uzasadnienie postanowienia." },
  ];
  for (const { reasons, ruling, text } of expectations) {
    const judgment = await rowOf(sourceId, ruling);
    const absorbed = await rowOf(sourceId, reasons);
    expect(judgment.fulltext).toContain(text);
    expect(absorbed.fulltext).toBeNull();
    expect(absorbed.citationKey).toBeNull();
    expect(absorbed.metadata?.[ABSORBED_INTO_METADATA_KEY]).toEqual({
      decisionId: judgment.id,
      kind: "reasons",
      sourceDocumentId: String(reasons),
    });
    expect(await citationsOf(absorbed.id)).toEqual([]);
  }
  // The citations moved with the text.
  expect(await citationsOf((await rowOf(sourceId, 2001)).id)).toEqual([
    "sygn. akt V CSK 293/14",
  ]);
  expect(await citationsOf((await rowOf(sourceId, 3002)).id)).toEqual([
    "sygn. akt II K 494/17",
  ]);
  expect(await citationsOf((await rowOf(sourceId, 1002)).id)).toEqual([
    "III KK 195/16",
  ]);
  // The same docket at another court is not a sibling.
  expect((await rowOf(sourceId, 2501)).fulltext).not.toContain(
    "Uzasadnienie spisane później",
  );

  // Reasons with no ruling in the corpus stay readable, typed as what they
  // are, and wait parked for their ruling.
  const orphan = await rowOf(sourceId, 4001);
  expect(orphan.decisionType).toBe(PL_COURTS_STANDALONE_REASONS_DECISION_TYPE);
  expect(orphan.fulltext).toContain("Uzasadnienie bez orzeczenia");
  expect(await citationsOf(orphan.id)).toEqual(["sygn. akt V CSK 293/14"]);
  const parked = await db
    .select({ decisionId: caseLawDecisionSupplements.decisionId })
    .from(caseLawDecisionSupplements)
    .where(
      and(
        eq(caseLawDecisionSupplements.sourceId, sourceId),
        eq(caseLawDecisionSupplements.sourceDocumentId, "4001"),
      ),
    );
  expect(parked).toEqual([{ decisionId: null }]);

  const published = (
    await db
      .select({ sourceDocumentId: caseLawDecisions.sourceDocumentId })
      .from(caseLawDecisions)
      .where(
        and(eq(caseLawDecisions.sourceId, sourceId), publishedCaseLawDecision),
      )
  )
    .map(({ sourceDocumentId }) => sourceDocumentId ?? "")
    .toSorted(byCodeUnit);
  expect(published).toEqual(
    [...RULINGS, SEED.orphanReasons]
      .map(({ id }) => String(id))
      .toSorted(byCodeUnit),
  );

  // Folded rows leave the selection: a second pass finds nothing to do.
  const again = await fold();
  expect(again.visited).toBe(0);
  await sourceLease.release();
});
