import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import {
  CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE,
  caseLawCitations,
  caseLawDecisionIdentifierBackfills,
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_RESOLUTION_STATUS } from "@/api/handlers/case-law/citation-resolution-status";
import { normalizeDecisionIdentifierValue } from "@/api/handlers/case-law/ingestion/citation-extractor";
import {
  DECISION_IDENTIFIER_BACKFILL_VERSION,
  MAX_DECISION_IDENTIFIER_BACKFILL_BATCH_SIZE,
  runDecisionIdentifierBackfill,
  verifyDecisionIdentifierBackfill,
} from "@/api/handlers/case-law/ingestion/decision-identifier-backfill";
import type { DecisionIdentifierBackfillProgress } from "@/api/handlers/case-law/ingestion/decision-identifier-backfill";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawRootHandle } from "@/api/lib/case-law/maintenance-lane";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const decisionId = createSafeId<"caseLawDecision">();
const caseNumberCitationId = createSafeId<"caseLawCitation">();
const ecliCitationId = createSafeId<"caseLawCitation">();

// PGlite and Bun SQL use different driver result wrappers, but expose the
// same transaction/execute surface consumed by the backfill.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- structural test adapter across Drizzle drivers
const rootDb = () => db as unknown as CaseLawRootHandle;

const checkpoint = async () =>
  (
    await db
      .select()
      .from(caseLawDecisionIdentifierBackfills)
      .where(
        eq(
          caseLawDecisionIdentifierBackfills.version,
          DECISION_IDENTIFIER_BACKFILL_VERSION,
        ),
      )
      .limit(1)
  ).at(0);

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `identifier-backfill-${Bun.randomUUIDv7().slice(0, 16)}`,
    name: "Decision identifier backfill test",
  });
  await db.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId,
    caseNumber: "I ACa 1/24",
    ecli: "ECLI:PL:TEST:1",
    court: "Test court",
    country: "POL",
    language: "pl",
    slug: "decision-identifier-backfill",
    languageGroupKey: "decision-identifier-backfill",
    metadata: {
      additionalCaseNumbers: ["I ACz 2/24"],
      citation: "12 Test Reporter 34",
    },
  });
  await db.insert(caseLawDecisionIdentifiers).values({
    decisionId,
    type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
    value: "stale reporter",
    normalizedValue: "stale reporter",
  });
  await db.insert(caseLawCitations).values([
    {
      id: caseNumberCitationId,
      citingDecisionId: decisionId,
      citationText: "I ACz 2/24",
      citationKey: "iacz 2/24",
      resolutionStatus: CITATION_RESOLUTION_STATUS.UNMATCHED,
      resolutionAttemptedAt: new Date("2026-08-24T10:00:00.000Z"),
    },
    {
      id: ecliCitationId,
      citingDecisionId: decisionId,
      citationText: "ECLI:PL:TEST:1",
      citationKey: "ecli:pl:test:1",
      identifierType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
      normalizedIdentifierValue: "wrong",
      resolutionStatus: CITATION_RESOLUTION_STATUS.UNMATCHED,
      resolutionAttemptedAt: new Date("2026-08-24T10:00:00.000Z"),
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

test("resumes committed pages and converges to an exact replay-safe projection", async () => {
  let interrupted = false;
  const interruptedRun = runDecisionIdentifierBackfill(rootDb(), {
    batchSize: 1,
    onProgress: (progress) => {
      if (
        !interrupted &&
        progress.type === "page" &&
        progress.progress.phase ===
          CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS
      ) {
        interrupted = true;
        throw new Error("simulated operator interruption");
      }
    },
  });
  // bun-types declares `.rejects.toThrow` as void; capture the rejection so
  // type-aware lint and the runtime observe the same promise.
  const interruption: unknown = await interruptedRun.then(
    () => null,
    (error: unknown) => error,
  );
  expect(interruption).toMatchObject({
    message: "simulated operator interruption",
  });

  const interruptedCheckpoint = await checkpoint();
  expect(interruptedCheckpoint).toMatchObject({
    phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.DECISIONS,
    cursorId: decisionId,
    decisionsScanned: 1,
  });

  const result = await runDecisionIdentifierBackfill(rootDb(), {
    batchSize: 1,
  });
  expect(result.verification.status).toBe("awaiting-resolution-drain");

  const identifiers = await db
    .select({
      type: caseLawDecisionIdentifiers.type,
      value: caseLawDecisionIdentifiers.value,
    })
    .from(caseLawDecisionIdentifiers)
    .where(eq(caseLawDecisionIdentifiers.decisionId, decisionId))
    .orderBy(
      asc(caseLawDecisionIdentifiers.type),
      asc(caseLawDecisionIdentifiers.value),
    );
  expect(identifiers).toEqual([
    { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "I ACa 1/24" },
    { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "I ACz 2/24" },
    { type: DECISION_IDENTIFIER_TYPES.ECLI, value: "ECLI:PL:TEST:1" },
    {
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      value: "12 Test Reporter 34",
    },
  ]);

  const citations = await db
    .select({
      id: caseLawCitations.id,
      identifierType: caseLawCitations.identifierType,
      normalizedIdentifierValue: caseLawCitations.normalizedIdentifierValue,
      resolutionStatus: caseLawCitations.resolutionStatus,
      resolutionAttemptedAt: caseLawCitations.resolutionAttemptedAt,
    })
    .from(caseLawCitations)
    .orderBy(asc(caseLawCitations.id));
  expect(citations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: caseNumberCitationId,
        identifierType: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        normalizedIdentifierValue: normalizeDecisionIdentifierValue(
          DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
          "I ACz 2/24",
        ),
        resolutionStatus: CITATION_RESOLUTION_STATUS.PENDING,
        resolutionAttemptedAt: null,
      }),
      {
        id: ecliCitationId,
        identifierType: DECISION_IDENTIFIER_TYPES.ECLI,
        normalizedIdentifierValue: normalizeDecisionIdentifierValue(
          DECISION_IDENTIFIER_TYPES.ECLI,
          "ECLI:PL:TEST:1",
        ),
        resolutionStatus: CITATION_RESOLUTION_STATUS.PENDING,
        resolutionAttemptedAt: null,
      },
    ]),
  );

  await db
    .update(caseLawCitations)
    .set({ resolutionStatus: CITATION_RESOLUTION_STATUS.UNMATCHED })
    .where(
      inArray(caseLawCitations.id, [caseNumberCitationId, ecliCitationId]),
    );
  const ready = await verifyDecisionIdentifierBackfill(rootDb(), 1);
  expect(ready.status).toBe("ready-for-cutover");

  const checkpointBeforeReplay = await checkpoint();
  const replay = await runDecisionIdentifierBackfill(rootDb(), {
    batchSize: 1,
  });
  const checkpointAfterReplay = await checkpoint();
  expect(replay.verification.status).toBe("ready-for-cutover");
  expect(checkpointAfterReplay).toEqual(checkpointBeforeReplay);
});

test("a completion receipt does not hide later projection drift", async () => {
  await db
    .update(caseLawCitations)
    .set({ normalizedIdentifierValue: "drifted" })
    .where(eq(caseLawCitations.id, caseNumberCitationId));

  const verification = await verifyDecisionIdentifierBackfill(rootDb(), 1);
  expect(verification).toMatchObject({
    status: "backfill-required",
    gaps: { citationIdentifierMismatches: 1 },
  });

  const repaired = await runDecisionIdentifierBackfill(rootDb(), {
    batchSize: 1,
  });
  expect(repaired.verification.status).toBe("awaiting-resolution-drain");
  expect(await checkpoint()).toMatchObject({
    phase: CASE_LAW_DECISION_IDENTIFIER_BACKFILL_PHASE.COMPLETE,
    cursorId: null,
  });
});

test("rejects a batch that could exceed PostgreSQL's bind-parameter limit", async () => {
  expect(MAX_DECISION_IDENTIFIER_BACKFILL_BATCH_SIZE).toBe(500);
  const outcome: unknown = await runDecisionIdentifierBackfill(rootDb(), {
    batchSize: 501,
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toMatchObject({
    message:
      "Decision identifier backfill batch size must be an integer from 1 to 500",
  });
});

test("advances past malformed decisions but bounds non-converging retries", async () => {
  const malformedDecisionId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id: malformedDecisionId,
    sourceId,
    caseNumber: "   ",
    court: "Test court",
    country: "POL",
    language: "pl",
    slug: `malformed-${malformedDecisionId}`,
    languageGroupKey: `malformed-${malformedDecisionId}`,
    metadata: {},
  });

  const progress: DecisionIdentifierBackfillProgress[] = [];
  const outcome: unknown = await runDecisionIdentifierBackfill(rootDb(), {
    batchSize: 1,
    onProgress: (event) => {
      progress.push(event);
    },
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(outcome).toMatchObject({
    message: expect.stringContaining(
      "Decision identifier backfill did not converge after 3 retries",
    ),
  });
  expect(
    progress.some(
      (event) => event.type === "page" && event.progress.decisionsScanned >= 2,
    ),
  ).toBe(true);
  expect(
    progress
      .filter((event) => event.type === "retry")
      .map((event) => event.attempt),
  ).toEqual([1, 2, 3]);
});
