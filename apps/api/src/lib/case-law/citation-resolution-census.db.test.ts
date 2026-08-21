import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitationResolutionCensus,
  caseLawCitationResolutionCensusRuns,
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  type CensusDb,
  CITATION_CENSUS_KEY_BATCH,
  readCitationResolutionCensus,
  runCitationResolutionCensus,
} from "@/api/lib/case-law/citation-resolution-census";
import {
  CITATION_AMBIGUITY_SHAPE,
  CITATION_AMBIGUITY_SHAPE_DISPOSITION,
  CITATION_AMBIGUITY_SHAPES,
  CITATION_CENSUS_RUN_STATUS,
  CITATION_CENSUS_UNATTRIBUTED_RULE,
  type CitationAmbiguityShape,
} from "@/api/lib/case-law/citation-resolution-census-consts";
import {
  CITATION_CANDIDATE_SCAN_CAP,
  CITATION_RESOLUTION_RULE,
  CITATION_RESOLUTION_STATUS,
  MERITS_DECISION_TYPES,
  PROCEDURAL_DECISION_TYPES,
} from "@/api/lib/case-law/citation-resolution-status";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * One ambiguous key per shape, cited from one court, plus a handful of
 * settled rows for the status and rule counts. The census must file each
 * key under exactly the shape its holders have, and the shape set it
 * exercises must be the shape set it declares, in both directions.
 *
 * The holders a shape is read from are the resolver's candidates, not every
 * decision under the key: the one-file key also has a holder dated after
 * the citing decision, which the time rule removes for both.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const [MERITS] = MERITS_DECISION_TYPES;
const [PROCEDURAL_CZ] = PROCEDURAL_DECISION_TYPES;

const usSource = createSafeId<"caseLawSource">();
const nsSource = createSafeId<"caseLawSource">();
const citing = createSafeId<"caseLawDecision">();
const otherCourtCiting = createSafeId<"caseLawDecision">();

const censusDb: CensusDb = async (fn) => await fn(db);

/** Keys by the shape their holders are built to have. */
const KEY_BY_SHAPE = {
  [CITATION_AMBIGUITY_SHAPE.AT_CAP]: "plús50/16",
  [CITATION_AMBIGUITY_SHAPE.CROSS_COURT]: "iús30/16",
  [CITATION_AMBIGUITY_SHAPE.UNTYPED]: "ivús20/16",
  [CITATION_AMBIGUITY_SHAPE.ONE_FILE_MERITS]: "iiús2766/14",
  [CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY]: "iús70/16",
  [CITATION_AMBIGUITY_SHAPE.MERITS_ONLY]: "iiiús10/16",
  [CITATION_AMBIGUITY_SHAPE.OTHER]: "iús80/16",
} as const satisfies Record<CitationAmbiguityShape, string>;

const holder = (
  citationKey: string,
  decisionType: string | null,
  fields: {
    court?: string;
    sourceId?: SafeId<"caseLawSource">;
    decisionDate?: string;
  } = {},
) => ({
  id: createSafeId<"caseLawDecision">(),
  sourceId: fields.sourceId ?? usSource,
  court: fields.court ?? "Ústavní soud",
  country: "CZE",
  language: "cs",
  fulltext: "text",
  caseNumber: citationKey,
  citationKey,
  decisionDate: fields.decisionDate ?? "2016-01-01",
  decisionType,
  sourceDocumentId: createSafeId<"caseLawDecision">(),
  slug: createSafeId<"caseLawDecision">(),
  languageGroupKey: createSafeId<"caseLawDecision">(),
});

const ambiguous = (
  citingDecisionId: SafeId<"caseLawDecision">,
  citationKey: string,
) => ({
  id: createSafeId<"caseLawCitation">(),
  citingDecisionId,
  citationText: citationKey,
  citationKey,
  resolutionStatus: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
  resolutionAttemptedAt: new Date("2026-01-01T00:00:00Z"),
});

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db.insert(caseLawSources).values([
      { id: usSource, adapterKey: "cz-us", name: "constitutional court" },
      { id: nsSource, adapterKey: "cz-ns", name: "supreme court" },
    ]);

    const resolvedTarget = holder("plús1/19", MERITS);
    await db.insert(caseLawDecisions).values([
      // The citers are dated 2020; a holder dated after them is not a
      // candidate for their citations.
      {
        ...holder("plús1/20", MERITS, { decisionDate: "2020-06-01" }),
        id: citing,
      },
      {
        ...holder("cdo1/20", "rozsudek", {
          court: "Nejvyšší soud",
          sourceId: nsSource,
          decisionDate: "2020-06-01",
        }),
        id: otherCourtCiting,
      },
      resolvedTarget,
      // at-cap: as many holders as the resolver reads.
      ...Array.from({ length: CITATION_CANDIDATE_SCAN_CAP }, (_, index) =>
        holder(
          KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.AT_CAP],
          index === 0 ? MERITS : PROCEDURAL_CZ,
        ),
      ),
      // cross-court: a nález here, an order under the same key elsewhere.
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.CROSS_COURT], MERITS),
      holder(
        KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.CROSS_COURT],
        PROCEDURAL_CZ,
        {
          court: "Nejvyšší soud",
          sourceId: nsSource,
        },
      ),
      // untyped: one holder without a recorded type.
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.UNTYPED], MERITS),
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.UNTYPED], null),
      // one-file-merits: a nález and two orders at one court, plus a
      // second nález under the same key handed down after the citers.
      // The resolver's time rule drops it; read with it the key would be
      // two nálezy and the census would file a ruled key as unruled.
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.ONE_FILE_MERITS], MERITS),
      holder(
        KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.ONE_FILE_MERITS],
        PROCEDURAL_CZ,
      ),
      holder(
        KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.ONE_FILE_MERITS],
        PROCEDURAL_CZ,
      ),
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.ONE_FILE_MERITS], MERITS, {
        decisionDate: "2024-01-01",
      }),
      // orders-only.
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY], PROCEDURAL_CZ),
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY], PROCEDURAL_CZ),
      // merits-only: two nálezy.
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.MERITS_ONLY], MERITS),
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.MERITS_ONLY], MERITS),
      // other: a judgment and an order, a mix no rule describes.
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.OTHER], "rozsudek"),
      holder(KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.OTHER], PROCEDURAL_CZ),
    ]);

    await db.insert(caseLawCitations).values([
      ...CITATION_AMBIGUITY_SHAPES.map((shape) =>
        ambiguous(citing, KEY_BY_SHAPE[shape]),
      ),
      // The cross-court key cited twice more, from the other court.
      ambiguous(
        otherCourtCiting,
        KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.CROSS_COURT],
      ),
      ambiguous(
        otherCourtCiting,
        KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.CROSS_COURT],
      ),
      // Settled rows: two resolved by different rules, one resolved before
      // rules were recorded, one unmatched, and a procedural-kind row the
      // census must ignore.
      {
        id: createSafeId<"caseLawCitation">(),
        citingDecisionId: citing,
        citationText: "Pl. ÚS 1/19",
        citationKey: "plús1/19",
        citedDecisionId: resolvedTarget.id,
        resolutionStatus: CITATION_RESOLUTION_STATUS.RESOLVED,
        resolutionRuleId: CITATION_RESOLUTION_RULE.UNIQUE_KEY,
      },
      {
        id: createSafeId<"caseLawCitation">(),
        citingDecisionId: otherCourtCiting,
        citationText: "Pl. ÚS 1/19",
        citationKey: "plús1/19",
        citedDecisionId: resolvedTarget.id,
        resolutionStatus: CITATION_RESOLUTION_STATUS.RESOLVED,
        resolutionRuleId: CITATION_RESOLUTION_RULE.TYPE_HINT,
      },
      {
        id: createSafeId<"caseLawCitation">(),
        citingDecisionId: otherCourtCiting,
        citationText: "Pl. ÚS 1/19",
        citationKey: "plús1/19",
        citedDecisionId: resolvedTarget.id,
        resolutionStatus: CITATION_RESOLUTION_STATUS.RESOLVED,
        resolutionRuleId: null,
      },
      {
        id: createSafeId<"caseLawCitation">(),
        citingDecisionId: citing,
        citationText: "Pl. ÚS 9/99",
        citationKey: "plús9/99",
        resolutionStatus: CITATION_RESOLUTION_STATUS.UNMATCHED,
      },
      {
        id: createSafeId<"caseLawCitation">(),
        citingDecisionId: citing,
        citationText: "1 Co 44/2013",
        citationKey: "1co44/2013",
        kind: "procedural",
        resolutionStatus: CITATION_RESOLUTION_STATUS.AMBIGUOUS,
      },
    ]);
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

const shapeRows = async (runId: string) =>
  await db
    .select({
      country: caseLawCitationResolutionCensus.country,
      court: caseLawCitationResolutionCensus.court,
      bucket: caseLawCitationResolutionCensus.bucket,
      keys: caseLawCitationResolutionCensus.keys,
      citations: caseLawCitationResolutionCensus.citations,
    })
    .from(caseLawCitationResolutionCensus)
    .where(
      sql`${caseLawCitationResolutionCensus.runId} = ${runId}::uuid
        AND ${caseLawCitationResolutionCensus.kind} = 'shape'`,
    )
    .orderBy(
      caseLawCitationResolutionCensus.court,
      caseLawCitationResolutionCensus.bucket,
    )
    .limit(100);

// One invocation is one batch of one walk; a run closes on the first empty
// shape batch.
const runToCompletion = async (
  keyBatch: number = CITATION_CENSUS_KEY_BATCH,
): Promise<Awaited<ReturnType<typeof runCitationResolutionCensus>>> => {
  const outcome = await runCitationResolutionCensus({ db: censusDb, keyBatch });
  if (outcome.status === CITATION_CENSUS_RUN_STATUS.COMPLETE) {
    return outcome;
  }
  return await runToCompletion(keyBatch);
};

type CensusOutcome = Awaited<ReturnType<typeof runCitationResolutionCensus>>;

// Invoke until the run leaves `status`, summing the rows read on the way.
const advanceWhile = async (
  status: CensusOutcome["status"],
  keyBatch: number,
  read: number,
): Promise<{ outcome: CensusOutcome; read: number }> => {
  const outcome = await runCitationResolutionCensus({ db: censusDb, keyBatch });
  const total = read + outcome.keysScannedNow;
  if (outcome.status !== status) {
    return { outcome, read: total };
  }
  return await advanceWhile(status, keyBatch, total);
};

// Precedent citations seeded above: one ambiguous per shape, two more
// cross-court, three resolved, one unmatched.
const PRECEDENT_CITATIONS = CITATION_AMBIGUITY_SHAPES.length + 2 + 3 + 1;

test("one invocation reads one batch of one walk; repeated invocations finish both walks", async () => {
  const first = await runCitationResolutionCensus({
    db: censusDb,
    keyBatch: 2,
  });
  expect(first.status).toBe(CITATION_CENSUS_RUN_STATUS.SCANNING_BASELINE);
  expect(first.keysScannedNow).toBe(2);

  // The baseline walk counts every precedent citation, two per call, then
  // one empty batch hands over to the shape walk.
  const { outcome, read: baselineRead } = await advanceWhile(
    CITATION_CENSUS_RUN_STATUS.SCANNING_BASELINE,
    2,
    first.keysScannedNow,
  );
  expect(outcome.id).toBe(first.id);
  expect(outcome.status).toBe(CITATION_CENSUS_RUN_STATUS.SCANNING_SHAPES);
  expect(baselineRead).toBe(PRECEDENT_CITATIONS);

  const shapes = await runCitationResolutionCensus({
    db: censusDb,
    keyBatch: 2,
  });
  expect(shapes.id).toBe(first.id);
  expect(shapes.status).toBe(CITATION_CENSUS_RUN_STATUS.SCANNING_SHAPES);
  expect(shapes.keysScannedNow).toBe(2);
  expect(shapes.keysScanned).toBe(2);

  const last = await runToCompletion(2);
  expect(last.id).toBe(first.id);
  expect(last.status).toBe(CITATION_CENSUS_RUN_STATUS.COMPLETE);
  expect(last.keysScannedNow).toBe(0);
  expect(last.keysScanned).toBe(CITATION_AMBIGUITY_SHAPES.length);

  const runs = await db
    .select({
      status: caseLawCitationResolutionCensusRuns.status,
      finishedAt: caseLawCitationResolutionCensusRuns.finishedAt,
      keysScanned: caseLawCitationResolutionCensusRuns.keysScanned,
    })
    .from(caseLawCitationResolutionCensusRuns)
    .limit(10);
  expect(runs).toHaveLength(1);
  expect(runs[0]?.status).toBe(CITATION_CENSUS_RUN_STATUS.COMPLETE);
  expect(runs[0]?.finishedAt).not.toBeNull();
  expect(runs[0]?.keysScanned).toBe(CITATION_AMBIGUITY_SHAPES.length);
});

test("every declared shape is exercised and every exercised shape is declared", async () => {
  const report = await readCitationResolutionCensus({
    db: censusDb,
    limit: 50,
  });
  const latest = report.latest;
  if (latest === null) {
    throw new Error("no census run");
  }

  const rows = await shapeRows(latest.id);
  const fromConstitutionalCourt = rows.filter(
    (row) => row.court === "Ústavní soud",
  );
  // One key per shape, cited once from the constitutional court.
  expect(
    fromConstitutionalCourt.map((row) => [row.bucket, row.keys, row.citations]),
  ).toEqual(
    [...CITATION_AMBIGUITY_SHAPES].sort().map((shape) => [shape, 1, 1]),
  );
  const exercised = new Set(rows.map((row) => row.bucket));
  expect([...exercised].sort()).toEqual([...CITATION_AMBIGUITY_SHAPES].sort());

  // The cross-court key is also cited twice from the supreme court, and
  // lands in the same shape there: the shape is the key's, the group is
  // the citer's.
  expect(rows.filter((row) => row.court === "Nejvyšší soud")).toEqual([
    {
      country: "CZE",
      court: "Nejvyšší soud",
      bucket: CITATION_AMBIGUITY_SHAPE.CROSS_COURT,
      keys: 1,
      citations: 2,
    },
  ]);
});

test("totals count precedent citations by status, rule and shape", async () => {
  const report = await readCitationResolutionCensus({
    db: censusDb,
    limit: 50,
  });
  expect(report.byStatus).toEqual({
    [CITATION_RESOLUTION_STATUS.PENDING]: 0,
    [CITATION_RESOLUTION_STATUS.RESOLVED]: 3,
    [CITATION_RESOLUTION_STATUS.UNMATCHED]: 1,
    // Seven shapes from one court, two more cross-court citations from the
    // other; the procedural-kind row is not precedent and is not counted.
    [CITATION_RESOLUTION_STATUS.AMBIGUOUS]:
      CITATION_AMBIGUITY_SHAPES.length + 2,
  });
  // The row resolved before rules were recorded is counted, under its own
  // bucket, rather than missing from every rule.
  expect(report.byRule).toEqual({
    [CITATION_RESOLUTION_RULE.UNIQUE_KEY]: 1,
    [CITATION_RESOLUTION_RULE.TYPE_HINT]: 1,
    [CITATION_RESOLUTION_RULE.ONE_FILE_MERITS]: 0,
    [CITATION_CENSUS_UNATTRIBUTED_RULE]: 1,
  });
  expect(report.byShape[CITATION_AMBIGUITY_SHAPE.CROSS_COURT]).toBe(3);
  expect(report.byShape[CITATION_AMBIGUITY_SHAPE.ONE_FILE_MERITS]).toBe(1);

  // The unruled list carries only shapes no rule owns, largest first, and
  // has no deltas yet: there is no earlier complete run to compare with.
  expect(report.previous).toBeNull();
  expect(report.unruled.at(0)).toMatchObject({
    court: "Nejvyšší soud",
    shape: CITATION_AMBIGUITY_SHAPE.CROSS_COURT,
    citations: 2,
    delta: null,
  });
  for (const group of report.unruled) {
    expect(CITATION_AMBIGUITY_SHAPE_DISPOSITION[group.shape].kind).toBe(
      "unruled",
    );
  }
});

test("a row settled after the run started belongs to the next run", async () => {
  // Start a run and let its baseline walk begin; a key that the resolver
  // settles as ambiguous after the cutoff is invisible to this run's two
  // walks alike, and counted by the next run.
  const started = await runCitationResolutionCensus({
    db: censusDb,
    keyBatch: 2,
  });
  expect(started.status).toBe(CITATION_CENSUS_RUN_STATUS.SCANNING_BASELINE);
  const lateKey = "iús90/16";
  await db
    .insert(caseLawDecisions)
    .values([holder(lateKey, PROCEDURAL_CZ), holder(lateKey, PROCEDURAL_CZ)]);
  await db.insert(caseLawCitations).values([
    {
      ...ambiguous(citing, lateKey),
      // Existed before the run (created earlier), settled after it started.
      createdAt: new Date("2026-01-01T00:00:00Z"),
      resolutionAttemptedAt: new Date(started.startedAt.getTime() + 5),
    },
  ]);

  const run = await runToCompletion(2);
  expect(run.id).toBe(started.id);
  expect(run.keysScanned).toBe(CITATION_AMBIGUITY_SHAPES.length);
  const report = await readCitationResolutionCensus({
    db: censusDb,
    limit: 50,
  });
  expect(report.byStatus[CITATION_RESOLUTION_STATUS.AMBIGUOUS]).toBe(
    CITATION_AMBIGUITY_SHAPES.length + 2,
  );

  const next = await runToCompletion();
  expect(next.id).not.toBe(run.id);
  expect(next.keysScanned).toBe(CITATION_AMBIGUITY_SHAPES.length + 1);
  const nextReport = await readCitationResolutionCensus({
    db: censusDb,
    limit: 50,
  });
  expect(nextReport.byStatus[CITATION_RESOLUTION_STATUS.AMBIGUOUS]).toBe(
    CITATION_AMBIGUITY_SHAPES.length + 3,
  );
  expect(nextReport.byShape[CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY]).toBe(2);
});

test("a second complete run reports deltas against the first", async () => {
  // The supreme court cites the orders-only key once more before the next
  // snapshot; every other group is unchanged.
  await db
    .insert(caseLawCitations)
    .values([
      ambiguous(
        otherCourtCiting,
        KEY_BY_SHAPE[CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY],
      ),
    ]);

  const run = await runToCompletion();
  expect(run.status).toBe(CITATION_CENSUS_RUN_STATUS.COMPLETE);

  const report = await readCitationResolutionCensus({
    db: censusDb,
    limit: 50,
  });
  expect(report.latest?.id).toBe(run.id);
  expect(report.previous).not.toBeNull();
  expect(report.previous?.id).not.toBe(run.id);

  const byGroup = new Map(
    report.unruled.map((group) => [
      `${group.court}/${group.shape}`,
      group.delta,
    ]),
  );
  expect(
    byGroup.get(`Nejvyšší soud/${CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY}`),
  ).toBe(1);
  expect(
    byGroup.get(`Nejvyšší soud/${CITATION_AMBIGUITY_SHAPE.CROSS_COURT}`),
  ).toBe(0);
  expect(
    byGroup.get(`Ústavní soud/${CITATION_AMBIGUITY_SHAPE.CROSS_COURT}`),
  ).toBe(0);
});

// drizzle wraps driver errors as "Failed query"; the constraint name lives on
// the cause.
const rejectionCause = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    return cause instanceof Error ? cause.message : String(error);
  }
  return "resolved";
};

test("a key whose holders are all gone is `other`, not a ruled shape", async () => {
  // Ambiguous when the resolver last looked; its holders have since been
  // removed, so there is no file for a rule to act on.
  await db.insert(caseLawCitations).values([ambiguous(citing, "vús99/16")]);

  const before = await readCitationResolutionCensus({
    db: censusDb,
    limit: 50,
  });
  const run = await runToCompletion();
  expect(run.status).toBe(CITATION_CENSUS_RUN_STATUS.COMPLETE);

  const after = await readCitationResolutionCensus({
    db: censusDb,
    limit: 50,
  });
  expect(after.byShape[CITATION_AMBIGUITY_SHAPE.OTHER]).toBe(
    before.byShape[CITATION_AMBIGUITY_SHAPE.OTHER] + 1,
  );
  expect(after.byShape[CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY]).toBe(
    before.byShape[CITATION_AMBIGUITY_SHAPE.ORDERS_ONLY],
  );
});

test("a baseline cursor is a pair or nothing", async () => {
  const run = await runCitationResolutionCensus({ db: censusDb, keyBatch: 1 });
  expect(run.status).toBe(CITATION_CENSUS_RUN_STATUS.SCANNING_BASELINE);

  expect(
    await rejectionCause(
      db.execute(sql`
        UPDATE ${caseLawCitationResolutionCensusRuns}
           SET cursor_citing_decision_id = ${citing}::uuid,
               cursor_citation_id = NULL
         WHERE id = ${run.id}::uuid
      `),
    ),
  ).toMatch(/cursor_pair/u);

  await runToCompletion();
});

test("only one run can be open at a time", async () => {
  const run = await runCitationResolutionCensus({ db: censusDb, keyBatch: 1 });
  expect(run.status).toBe(CITATION_CENSUS_RUN_STATUS.SCANNING_BASELINE);

  // A second invocation that raced past the lock and tried to start its own
  // walk hits the open-run index instead of counting the population twice.
  expect(
    await rejectionCause(
      db.execute(sql`
        INSERT INTO ${caseLawCitationResolutionCensusRuns}
          (id, status, started_at, keys_scanned, cursor_key)
        VALUES (${createSafeId<"caseLawCitationResolutionCensusRun">()}::uuid,
                ${CITATION_CENSUS_RUN_STATUS.SCANNING_BASELINE}, now(), 0, NULL)
      `),
    ),
  ).toMatch(/open_uidx/u);

  // The invocation that finds the open run continues it rather than
  // starting over: the same run id reaches completion.
  const finished = await runToCompletion();
  expect(finished.id).toBe(run.id);
});
