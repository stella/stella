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
import { and, asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_DOCUMENT_ROLE } from "@stll/api-contract/decision-document-role";

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
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import type {
  DecisionSupplement,
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
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import {
  PROCESS_DECISION_STATUS,
  SUPPLEMENT_RETRY_REASON,
} from "@/api/handlers/case-law/ingestion/pipeline/outcomes";
import { processSupplement } from "@/api/handlers/case-law/ingestion/pipeline/supplement";
import { absorbStandaloneSupplementRow } from "@/api/handlers/case-law/ingestion/supplement-absorption";
import { DOCUMENT_SUPPLEMENTS_METADATA_KEY } from "@/api/handlers/case-law/ingestion/supplement-composition";
import { redactCaseLawDecisionWithSupplementHolders } from "@/api/handlers/case-law/ingestion/supplement-erasure";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { ABSORBED_INTO_METADATA_KEY } from "@/api/lib/case-law/decision-absorption";
import { publishedCaseLawDecision } from "@/api/lib/case-law/published-decisions";
import {
  UNPERSISTABLE_DECISION_FIELDS,
  UnpersistableDecisionFieldError,
} from "@/api/lib/errors/tagged-errors";
import { sweepCaseLawRawDecision } from "@/api/lib/legal-search/case-law-raw-sweeps";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import {
  RAW_SOURCE_FAMILY,
  rawDocumentPrefix,
} from "@/api/lib/legal-search/raw-source-storage";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
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
      sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
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

const observationOrderOf = async (id: SafeId<"caseLawDecision">) =>
  (
    await db
      .select({ order: caseLawDecisions.sourceObservationOrder })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, id))
      .limit(1)
  ).at(0)?.order ?? panic(`no observation order for ${id}`);

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
        sourceRawS3Key: caseLawDecisionSupplements.sourceRawS3Key,
        metadata: caseLawDecisionSupplements.metadata,
      })
      .from(caseLawDecisionSupplements)
      .where(
        and(
          eq(caseLawDecisionSupplements.sourceId, sourceId),
          eq(caseLawDecisionSupplements.sourceDocumentId, sourceDocumentId),
        ),
      )
  ).at(0) ?? panic(`no supplement ${sourceDocumentId}`);

/**
 * The fixture numbers observations itself; a write under the source's lease
 * takes the source's counter, which starts past them here.
 */
const advanceSourceCounter = async (sourceId: SafeId<"caseLawSource">) => {
  await db
    .update(caseLawSources)
    .set({ observationOrder: 1_000_000n })
    .where(eq(caseLawSources.id, sourceId));
};

/** The raw object keys stored under one decision's own prefix. */
const rawKeysUnder = (
  sourceId: SafeId<"caseLawSource">,
  documentId: SafeId<"caseLawDecision">,
): string[] => {
  const bucket = `${envBase.S3_BUCKET}/`;
  const prefix = rawDocumentPrefix({
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId,
    documentId,
  });
  return [...fake.objects.keys()]
    .filter((id) => id.startsWith(`${bucket}${prefix}`))
    .map((id) => id.slice(bucket.length))
    .toSorted(byCodeUnit);
};

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
    expect(ruling.metadata?.["documentRole"]).toBe(
      DECISION_DOCUMENT_ROLE.RULING,
    );
    expect(ruling.sourceHash).not.toBe(before.sourceHash);
    expect(ruling.metadata?.[DOCUMENT_SUPPLEMENTS_METADATA_KEY]).toEqual([
      expect.objectContaining({ kind: "reasons", sourceDocumentId: "339001" }),
    ]);
    expect(await citationsOf(ruling.id)).toEqual(["sygn. akt V CSK 293/14"]);
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(stored.decisionId).toBe(ruling.id);
    expect(stored.mergedSourceHash).toBe(stored.sourceHash);
    expect(stored.metadata["documentRole"]).toBe(
      DECISION_DOCUMENT_ROLE.REASONS,
    );
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
    const standaloneOrder = await observationOrderOf(standalone.id);
    expect(standalone.decisionType).toBe(
      PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
    );
    expect(standalone.metadata?.["documentRole"]).toBe(
      DECISION_DOCUMENT_ROLE.REASONS,
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
    expect(ruling.decisionType).toBe("wyrok");
    expect(ruling.metadata?.["documentRole"]).toBe(
      DECISION_DOCUMENT_ROLE.RULING,
    );
    expect(await citationsOf(ruling.id)).toEqual(["sygn. akt V CSK 293/14"]);
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(stored.decisionId).toBe(ruling.id);
    expect(stored.mergedSourceHash).toBe(stored.sourceHash);

    // The standalone row is absorbed: kept, unpublished, and no longer a
    // second holder of the docket or a second copy of the citations.
    const absorbed = await decisionBy(fixture.sourceId, "339001");
    expect(absorbed.id).toBe(standalone.id);
    expect(absorbed.sourceHash).toBeNull();
    expect(await observationOrderOf(absorbed.id)).toBeGreaterThan(
      standaloneOrder,
    );
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

  test("an unknown publisher role stays unknown in both supplement and standalone metadata", async () => {
    const fixture = await newSource();
    const reasons = supplementOf(REASONS);
    await ingestSupplement(fixture, {
      ...reasons,
      document: { ...reasons.document, documentRole: undefined },
    });
    const standalone = await decisionBy(fixture.sourceId, "339001");
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(standalone.metadata?.["documentRole"]).toBeUndefined();
    expect(stored.metadata["documentRole"]).toBeUndefined();
    expect(standalone.decisionType).toBe(
      PL_COURTS_STANDALONE_REASONS_DECISION_TYPE,
    );
  });

  test("a supplement kind cannot contradict a known publisher role", async () => {
    const fixture = await newSource();
    const reasons = supplementOf(REASONS);
    const rejected = await Result.tryPromise({
      try: async () =>
        await ingestSupplement(fixture, {
          ...reasons,
          document: {
            ...reasons.document,
            documentRole: DECISION_DOCUMENT_ROLE.RULING,
          },
        }),
      catch: (cause) => cause,
    });
    if (!Result.isError(rejected)) {
      expect.unreachable("A contradictory publisher role must be rejected");
    }
    expect(rejected.error).toHaveProperty(
      "message",
      "Supplement kind contradicts the publisher document role",
    );
    expect(await decisionRows(fixture.sourceId)).toEqual([]);
  });

  test("an absorption older than the standalone row's last observation leaves it alone", async () => {
    const fixture = await newSource();
    await ingestSupplement(fixture, supplementOf(REASONS));
    const before = await decisionBy(fixture.sourceId, "339001");
    const standaloneOrder = await observationOrderOf(before.id);

    const outcome = await absorbStandaloneSupplementRow({
      scopedDb,
      sourceId: fixture.sourceId,
      kind: "reasons",
      sourceDocumentId: "339001",
      judgmentId: createSafeId<"caseLawDecision">(),
      observationOrder: standaloneOrder,
    });

    expect(outcome).toEqual(
      Result.ok({ type: "superseded", decisionId: before.id }),
    );
    expect(await decisionBy(fixture.sourceId, "339001")).toEqual(before);
    expect(await observationOrderOf(before.id)).toBe(standaloneOrder);
    expect(await publishedIds(fixture.sourceId)).toEqual(["339001"]);
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
    expect(merged.rows.at(0)?.metadata?.["documentRole"]).toBe(
      DECISION_DOCUMENT_ROLE.RULING,
    );
    expect(merged.rows.at(0)?.decisionType).toBe("wyrok");
    expect(merged.supplement.metadata["documentRole"]).toBe(
      DECISION_DOCUMENT_ROLE.REASONS,
    );

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
  return await ingestDecision(
    fixture,
    plainTextIngestionResult({
      ...document,
      decisionType: PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
      metadata: {
        ...document.metadata,
        decisionType: PL_COURTS_PRE_SUPPLEMENT_REASONS_DECISION_TYPE,
      },
    }),
  );
};

describe("the standalone row of reasons already stored", () => {
  test("a textless unmarked row is absorbed when its supplement is placed", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));
    await ingestStandaloneReasons(fixture);
    const before = await decisionBy(fixture.sourceId, "339001");
    expect(before.fulltext).toContain(REASONS_TEXT);
    expect(before.metadata?.[ABSORBED_INTO_METADATA_KEY]).toBeUndefined();
    await db
      .update(caseLawDecisions)
      .set({
        contentHash: null,
        textS3Key: null,
        normalizedS3Key: null,
        astS3Key: null,
        fulltext: null,
        documentAst: null,
        sections: null,
      })
      .where(eq(caseLawDecisions.id, before.id));
    const textless = await decisionBy(fixture.sourceId, "339001");
    expect(textless.fulltext).toBeNull();
    expect(textless.sourceHash).toBe(before.sourceHash);
    expect(textless.sourceRawS3Key).toBe(before.sourceRawS3Key);
    const supplement = supplementOf(REASONS);
    await db.insert(caseLawDecisionSupplements).values({
      sourceId: fixture.sourceId,
      sourceDocumentId: supplement.document.sourceDocumentId,
      kind: supplement.kind,
      caseNumber: supplement.document.caseNumber,
      court: supplement.document.court,
      language: supplement.document.language,
      latestDecisionDate: supplement.target.latestDecisionDate ?? null,
      judgmentDecisionTypes: [...supplement.target.decisionTypes],
      fulltext: supplement.document.fulltext ?? null,
      documentAst: supplement.document.documentAst,
      sourceHash: supplement.document.rawHash,
      metadata: supplement.document.metadata,
      observedAt: new Date("2026-09-23T10:00:00.000Z"),
    });
    expect(
      (await supplementRow(fixture.sourceId, "339001")).decisionId,
    ).toBeNull();

    const placed = await ingestSupplement(fixture, supplement);
    const ruling = await decisionBy(fixture.sourceId, "339002");
    expect(placed).toEqual({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "merged", judgmentId: ruling.id },
    });
    expect(ruling.fulltext).toContain(REASONS_TEXT);
    const absorbed = await decisionBy(fixture.sourceId, "339001");
    expect(absorbed.id).toBe(before.id);
    expect(absorbed.metadata?.[ABSORBED_INTO_METADATA_KEY]).toEqual({
      decisionId: ruling.id,
      kind: "reasons",
      sourceDocumentId: "339001",
    });
    expect(await publishedIds(fixture.sourceId)).toEqual(["339002"]);
  });

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

test("a ruling a correction dates after its reasons drops them and parks them again", async () => {
  const fixture = await newSource();
  await ingestDecision(fixture, decisionOf(RULING));
  await ingestSupplement(fixture, supplementOf(REASONS));
  const ruling = await decisionBy(fixture.sourceId, "339002");
  expect(ruling.fulltext).toContain(REASONS_TEXT);

  // Reasons may only join a ruling dated on or before them.
  await ingestDecision(
    fixture,
    decisionOf(
      saosRow({
        id: 339_002,
        judgmentType: "SENTENCE",
        judgmentDate: "2018-05-02",
        body: RULING_TEXT,
      }),
    ),
  );

  const corrected = await decisionBy(fixture.sourceId, "339002");
  expect(corrected.id).toBe(ruling.id);
  expect(corrected.fulltext).not.toContain(REASONS_TEXT);
  expect(await supplementRow(fixture.sourceId, "339001")).toMatchObject({
    decisionId: null,
    mergedSourceHash: null,
  });
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
      acquireStoredTotalAdmission: async () => "held",
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

describe("the reasons' stored payload", () => {
  test("stands under their own row while they stand alone", async () => {
    const fixture = await newSource();
    await ingestSupplement(fixture, supplementOf(REASONS));

    const standalone = await decisionBy(fixture.sourceId, "339001");
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(stored.sourceRawS3Key).not.toBeNull();
    expect(stored.sourceRawS3Key).toBe(standalone.sourceRawS3Key);
    expect(rawKeysUnder(fixture.sourceId, standalone.id)).toContain(
      stored.sourceRawS3Key ?? panic("no pointer"),
    );
  });

  test("moves under their ruling when they join it, and the row's copy goes", async () => {
    const fixture = await newSource();
    await ingestSupplement(fixture, supplementOf(REASONS));
    const standalone = await decisionBy(fixture.sourceId, "339001");

    await ingestDecision(fixture, decisionOf(RULING));

    const ruling = await decisionBy(fixture.sourceId, "339002");
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(stored.decisionId).toBe(ruling.id);
    expect(rawKeysUnder(fixture.sourceId, ruling.id)).toContain(
      stored.sourceRawS3Key ?? panic("no pointer"),
    );
    expect(rawKeysUnder(fixture.sourceId, standalone.id)).toEqual([]);
    expect(
      (await decisionBy(fixture.sourceId, "339001")).sourceRawS3Key,
    ).toBeNull();
  });

  test("merged on arrival are stored under their ruling alone", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));
    await ingestSupplement(fixture, supplementOf(REASONS));

    const ruling = await decisionBy(fixture.sourceId, "339002");
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(rawKeysUnder(fixture.sourceId, ruling.id)).toContain(
      stored.sourceRawS3Key ?? panic("no pointer"),
    );
  });

  test("moved by a correction leave nothing under their former ruling", async () => {
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
    const before = rawKeysUnder(fixture.sourceId, former.id);

    await ingestSupplement(
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
    const stored = await supplementRow(fixture.sourceId, "339001");
    expect(stored.decisionId).toBe(corrected.id);
    expect(rawKeysUnder(fixture.sourceId, corrected.id)).toContain(
      stored.sourceRawS3Key ?? panic("no pointer"),
    );
    // Only the former ruling's own payload stays under its prefix.
    const formerOwn =
      (await decisionBy(fixture.sourceId, "339002")).sourceRawS3Key ??
      panic("the former ruling lost its payload");
    expect(before.length).toBeGreaterThan(1);
    expect(rawKeysUnder(fixture.sourceId, former.id)).toEqual([formerOwn]);
  });

  test("go with an erasure of their own standalone row, and stay gone", async () => {
    const fixture = await newSource();
    await ingestSupplement(fixture, supplementOf(REASONS));
    const standalone = await decisionBy(fixture.sourceId, "339001");
    const supplementKey =
      (await supplementRow(fixture.sourceId, "339001")).sourceRawS3Key ??
      panic("no pointer");

    const erased = await redactCaseLawDecision({
      decisionId: standalone.id,
      scopedDb,
    });

    expect(Result.isOk(erased) && erased.value.type).toBe("redacted");
    const supplements = async () =>
      await db
        .select({ id: caseLawDecisionSupplements.sourceDocumentId })
        .from(caseLawDecisionSupplements)
        .where(eq(caseLawDecisionSupplements.sourceId, fixture.sourceId));
    expect(await supplements()).toEqual([]);
    expect(rawKeysUnder(fixture.sourceId, standalone.id)).toEqual([]);

    fake.put(envBase.S3_BUCKET, supplementKey, "late");
    await sweepCaseLawRawDecision({
      decisionId: standalone.id,
      sourceId: fixture.sourceId,
      scopedDb,
      signal: AbortSignal.timeout(10_000),
    });
    expect(rawKeysUnder(fixture.sourceId, standalone.id)).toEqual([]);

    // Observed again, even with their ruling stored since, the erased
    // reasons are neither kept nor composed into it.
    await ingestDecision(fixture, decisionOf(RULING));
    const again = await ingestSupplement(fixture, supplementOf(REASONS));
    expect(again).toEqual({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "erased", decisionId: standalone.id },
    });
    expect(await supplements()).toEqual([]);
    expect(
      (await decisionBy(fixture.sourceId, "339002")).fulltext,
    ).not.toContain(REASONS_TEXT);
  });

  test("erased after joining their ruling leave its document, and stay out of it", async () => {
    const fixture = await newSource();
    await ingestSupplement(fixture, supplementOf(REASONS));
    await ingestDecision(fixture, decisionOf(RULING));
    const absorbed = await decisionBy(fixture.sourceId, "339001");
    const ruling = await decisionBy(fixture.sourceId, "339002");
    expect(ruling.fulltext).toContain(REASONS_TEXT);
    await advanceSourceCounter(fixture.sourceId);

    const erased = await redactCaseLawDecisionWithSupplementHolders({
      decisionId: absorbed.id,
      scopedDb,
      readStoredRaw,
      reparseStoredRaw,
      leaseWaitMs: 0,
    });

    expect(Result.isOk(erased) && erased.value.holders).toEqual([
      { type: "recomposed", judgmentId: ruling.id },
    ]);
    const rebuilt = async () =>
      (
        await db
          .select({
            fulltext: caseLawDecisions.fulltext,
            documentAst: caseLawDecisions.documentAst,
            metadata: caseLawDecisions.metadata,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, ruling.id))
      ).at(0) ?? panic("the ruling is gone");
    const after = await rebuilt();
    expect(after.fulltext).toContain(RULING_TEXT);
    expect(after.fulltext).not.toContain(REASONS_TEXT);
    expect(JSON.stringify(after.documentAst)).not.toContain(REASONS_TEXT);
    expect(after.metadata?.[DOCUMENT_SUPPLEMENTS_METADATA_KEY]).toBeUndefined();
    expect(await citationsOf(ruling.id)).toEqual([]);
    expect(await publishedIds(fixture.sourceId)).toEqual(["339002"]);

    // Neither document observed again brings the erased text back.
    await ingestSupplement(fixture, supplementOf(REASONS));
    await ingestDecision(
      fixture,
      plainTextIngestionResult({
        ...decisionOf(RULING),
        rawHash: "re-observed",
      }),
    );
    const again = await rebuilt();
    expect(again.fulltext).not.toContain(REASONS_TEXT);
    expect(JSON.stringify(again.documentAst)).not.toContain(REASONS_TEXT);
    expect(await citationsOf(ruling.id)).toEqual([]);
  });

  test("supplement erasure persists the registered judgment URL spelling through the pipeline entry", async () => {
    const fixture = await newSource();
    await db
      .update(caseLawSources)
      .set({ adapterKey: sql`'retired-' || ${caseLawSources.id}` })
      .where(eq(caseLawSources.adapterKey, ADAPTER_KEYS.PL_COURTS));
    await db
      .update(caseLawSources)
      .set({ adapterKey: ADAPTER_KEYS.PL_COURTS })
      .where(eq(caseLawSources.id, fixture.sourceId));
    const rootUrl = "https://example.test/?root=&amp;amp;&encoded=%26";
    const nestedUrl = "https://example.test/?nested=&amp;lt;b&amp;gt;";
    const rulingRow = {
      ...RULING,
      href: rootUrl,
      division: { id: 1083, href: nestedUrl, court: { id: 42, name: COURT } },
    };
    await ingestSupplement(fixture, supplementOf(REASONS));
    await ingestDecision(fixture, decisionOf(rulingRow));
    const absorbed = await decisionBy(fixture.sourceId, "339001");
    const ruling = await decisionBy(fixture.sourceId, "339002");
    expect(ruling.fulltext).toContain(REASONS_TEXT);
    expect(ruling.metadata).toMatchObject({
      href: rootUrl,
      division: { href: nestedUrl },
    });
    await advanceSourceCounter(fixture.sourceId);

    const erased = await redactCaseLawDecisionWithSupplementHolders({
      decisionId: absorbed.id,
      scopedDb,
      readStoredRaw,
      reparseStoredRaw,
      leaseWaitMs: 0,
    });
    expect(Result.isOk(erased) && erased.value.holders).toEqual([
      { type: "recomposed", judgmentId: ruling.id },
    ]);
    const rebuilt = await decisionBy(fixture.sourceId, "339002");
    expect(rebuilt.fulltext).toContain(RULING_TEXT);
    expect(rebuilt.fulltext).not.toContain(REASONS_TEXT);
    expect(rebuilt.metadata).toMatchObject({
      href: rootUrl,
      division: { href: nestedUrl },
    });
    expect(
      rebuilt.metadata?.[DOCUMENT_SUPPLEMENTS_METADATA_KEY],
    ).toBeUndefined();
  });

  test("erased after joining a ruling whose payload cannot be read withhold that ruling", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));
    await ingestSupplement(fixture, supplementOf(REASONS));
    const ruling = await decisionBy(fixture.sourceId, "339002");
    // The reasons stood alone once in this history too: erase the row a
    // standalone observation left behind.
    await ingestStandaloneReasons(fixture);
    const standaloneId = (await decisionBy(fixture.sourceId, "339001")).id;

    const erased = await redactCaseLawDecisionWithSupplementHolders({
      decisionId: standaloneId,
      scopedDb,
      readStoredRaw: async () => await Promise.resolve(Result.ok(null)),
      reparseStoredRaw,
      leaseWaitMs: 0,
    });

    expect(Result.isOk(erased) && erased.value.holders).toEqual([
      {
        type: "withheld",
        judgmentId: ruling.id,
        reason: expect.any(String),
      },
    ]);
    const withheld = await decisionBy(fixture.sourceId, "339002");
    expect(withheld.fulltext).toBeNull();
    expect(await citationsOf(ruling.id)).toEqual([]);
    expect(await publishedIds(fixture.sourceId)).not.toContain("339002");
  });

  test("go with an erasure of their ruling, and stay gone", async () => {
    const fixture = await newSource();
    await ingestDecision(fixture, decisionOf(RULING));
    await ingestSupplement(fixture, supplementOf(REASONS));
    const ruling = await decisionBy(fixture.sourceId, "339002");
    const supplementKey =
      (await supplementRow(fixture.sourceId, "339001")).sourceRawS3Key ??
      panic("no pointer");

    const erased = await redactCaseLawDecision({
      decisionId: ruling.id,
      scopedDb,
    });

    expect(Result.isOk(erased) && erased.value.type).toBe("redacted");
    const remaining = await db
      .select({ id: caseLawDecisionSupplements.sourceDocumentId })
      .from(caseLawDecisionSupplements)
      .where(eq(caseLawDecisionSupplements.sourceId, fixture.sourceId));
    expect(remaining).toEqual([]);
    expect(rawKeysUnder(fixture.sourceId, ruling.id)).toEqual([]);

    // A write that landed after the erasure's own sweep is caught by the
    // follow-up sweep of the same prefix.
    fake.put(envBase.S3_BUCKET, supplementKey, "late");
    await sweepCaseLawRawDecision({
      decisionId: ruling.id,
      sourceId: fixture.sourceId,
      scopedDb,
      signal: AbortSignal.timeout(10_000),
    });
    expect(rawKeysUnder(fixture.sourceId, ruling.id)).toEqual([]);

    // Observed again, the reasons of an erased ruling are not kept.
    const again = await ingestSupplement(fixture, supplementOf(REASONS));
    expect(again).toEqual({
      status: PROCESS_DECISION_STATUS.COMPLETE,
      disposition: { type: "withheld", judgmentId: ruling.id },
    });
    expect(
      await db
        .select({ id: caseLawDecisionSupplements.sourceDocumentId })
        .from(caseLawDecisionSupplements)
        .where(eq(caseLawDecisionSupplements.sourceId, fixture.sourceId)),
    ).toEqual([]);
    expect(rawKeysUnder(fixture.sourceId, ruling.id)).toEqual([]);
  });
});

test("a supplement and its standalone decision share one persisted source schema lookup", async () => {
  const fixture = await newSource();
  let schemaReads = 0;
  const countedDb = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
    logger: {
      logQuery(query) {
        if (
          query.startsWith("select ") &&
          query.includes('"adapter_key"') &&
          query.includes('from "case_law_sources"')
        ) {
          schemaReads += 1;
        }
      },
    },
  });
  const countedScopedDb: ScopedDb = async (callback) =>
    await countedDb.transaction(async (tx) => await callback(asTestRaw(tx)));
  const placed = await processSupplement({
    supplement: supplementOf(REASONS),
    sourceId: fixture.sourceId,
    scopedDb: countedScopedDb,
    observedAt: new Date("2026-09-23T10:00:00.000Z"),
    nextObservationOrder: fixture.nextObservationOrder,
    reparseStoredRaw,
    readStoredRaw,
  });
  expect(placed).toMatchObject({
    status: PROCESS_DECISION_STATUS.COMPLETE,
    disposition: { type: "standalone", reason: "no-judgment" },
  });
  expect((await decisionBy(fixture.sourceId, "339001")).fulltext).toContain(
    REASONS_TEXT,
  );
  expect(schemaReads).toBe(1);
});

test("a jurisdiction keyed by publisher document takes no docket-keyed supplement", async () => {
  const fixture = await newSource();
  const reasons = supplementOf(REASONS);
  // The same supplement a docket-keyed jurisdiction places, relabelled.
  expect(reasons.document.country).not.toBe("USA");

  const placed: unknown = await ingestSupplement(fixture, {
    ...reasons,
    document: { ...reasons.document, country: "USA" },
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(placed).toBeInstanceOf(UnpersistableDecisionFieldError);
  expect(placed).toMatchObject({
    field: UNPERSISTABLE_DECISION_FIELDS.SUPPLEMENT,
  });
  expect(await decisionRows(fixture.sourceId)).toEqual([]);
  expect(
    await db
      .select({ id: caseLawDecisionSupplements.sourceDocumentId })
      .from(caseLawDecisionSupplements)
      .where(eq(caseLawDecisionSupplements.sourceId, fixture.sourceId)),
  ).toEqual([]);
});
