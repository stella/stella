import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawDecisions, caseLawReplayBlocked } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { STORED_RAW_REPARSE_REJECTION } from "@/api/lib/legal-search/ingestion-types";

import type { BackgroundReplayBatch } from "./background-replay";
import { completeReplayReceipt } from "./background-replay-store";
import {
  parsedReplayInputPredicate,
  REPLAY_ROW_OUTCOME,
  replayReadmissionInputPredicate,
  type ReplayRowReport,
  replaySelectionPredicate,
} from "./replay";

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const DECISION_ID = "00000000-0000-4000-8000-000000000011";
const OLD_HASH = "a".repeat(64);
const NEW_HASH = "b".repeat(64);
const OLD_RAW_KEY = "raw/decision-a";
const NEW_RAW_KEY = "raw/decision-b";

const SCHEMA = `
CREATE TABLE case_law_sources (id uuid PRIMARY KEY);
CREATE TABLE case_law_decisions (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES case_law_sources(id),
  parser_version integer,
  source_raw_s3_key text,
  source_hash varchar(64),
  source_hash_version integer,
  parsed_source_hash varchar(64),
  parsed_source_hash_version integer,
  parsed_source_raw_s3_key text,
  redacted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  corpus_mirror_status text NOT NULL DEFAULT 'settled'
);
CREATE TABLE case_law_replay_batches (
  id text PRIMARY KEY,
  source_id uuid NOT NULL,
  first_decision_id uuid NOT NULL,
  source_raw_s3_key text,
  parser_version_to integer NOT NULL,
  status text NOT NULL,
  outcome text,
  applied integer NOT NULL DEFAULT 0,
  blocked integer NOT NULL DEFAULT 0
);
CREATE TABLE case_law_replay_blocked (
  source_id uuid NOT NULL REFERENCES case_law_sources(id),
  decision_id uuid NOT NULL,
  source_raw_s3_key text,
  parser_version_from integer,
  parser_version_to integer NOT NULL,
  outcome text NOT NULL,
  reason text,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (decision_id, parser_version_to)
);`;

const createDatabase = async () => {
  const client = new PGlite();
  await client.exec(SCHEMA);
  await client.exec(`
    INSERT INTO case_law_sources VALUES ('${SOURCE_ID}');
    INSERT INTO case_law_decisions
      (id, source_id, parser_version, source_raw_s3_key, source_hash, source_hash_version)
    VALUES ('${DECISION_ID}', '${SOURCE_ID}', 1, '${OLD_RAW_KEY}', '${OLD_HASH}', 1);
  `);
  return { client, db: drizzle({ client }) };
};

const eligibleIds = async (db: ReturnType<typeof drizzle>): Promise<string[]> =>
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        and(
          eq(caseLawDecisions.sourceId, toSafeId(SOURCE_ID)),
          replaySelectionPredicate(
            {
              type: "background",
              currentParserVersion: 2,
              mode: "enrolled",
            },
            tx,
          ),
        ),
      );
    return rows.map(({ id }) => id);
  });

test.each([
  { key: null, outcome: "unchanged", eligible: true },
  { key: OLD_RAW_KEY, outcome: "rejected", eligible: false },
  { key: OLD_RAW_KEY, outcome: "unchanged", eligible: true },
] as const)(
  "only known exact-input rejection suppresses an unproved parse: %j",
  async ({ key, outcome, eligible }) => {
    const { client, db } = await createDatabase();
    try {
      await db.insert(caseLawReplayBlocked).values({
        sourceId: toSafeId(SOURCE_ID),
        decisionId: toSafeId(DECISION_ID),
        sourceRawS3Key: key,
        parserVersionFrom: 1,
        parserVersionTo: 2,
        outcome,
      });
      expect(await eligibleIds(db)).toEqual(eligible ? [DECISION_ID] : []);
      await db
        .update(caseLawDecisions)
        .set({
          sourceHash: NEW_HASH,
          sourceRawS3Key: NEW_RAW_KEY,
        })
        .where(eq(caseLawDecisions.id, toSafeId(DECISION_ID)));
      expect(await eligibleIds(db)).toEqual([DECISION_ID]);
    } finally {
      await client.close();
    }
  },
);

test("the target parser requires the complete current-input tuple", async () => {
  const { client, db } = await createDatabase();
  try {
    await db
      .update(caseLawDecisions)
      .set({ parserVersion: 2 })
      .where(eq(caseLawDecisions.id, toSafeId(DECISION_ID)));
    expect(await eligibleIds(db)).toEqual([DECISION_ID]);
    await db
      .update(caseLawDecisions)
      .set({
        parsedSourceHash: OLD_HASH,
        parsedSourceHashVersion: 1,
        parsedSourceRawS3Key: OLD_RAW_KEY,
      })
      .where(eq(caseLawDecisions.id, toSafeId(DECISION_ID)));
    expect(await eligibleIds(db)).toEqual([]);
    await db
      .update(caseLawDecisions)
      .set({ sourceHash: NEW_HASH })
      .where(eq(caseLawDecisions.id, toSafeId(DECISION_ID)));
    expect(await eligibleIds(db)).toEqual([DECISION_ID]);
  } finally {
    await client.close();
  }
});

test("completion cannot credit a different current input", async () => {
  const { client, db } = await createDatabase();
  try {
    await db
      .update(caseLawDecisions)
      .set({
        sourceHash: NEW_HASH,
        sourceRawS3Key: NEW_RAW_KEY,
      })
      .where(eq(caseLawDecisions.id, toSafeId(DECISION_ID)));
    const batch = {
      id: "receipt-generation",
      source: {
        id: toSafeId<"caseLawSource">(SOURCE_ID),
        adapterKey: "eu-ecj",
        currentParserVersion: 2,

        mode: "enrolled",
        rowsBehind: 1,
      },
      decisionId: toSafeId<"caseLawDecision">(DECISION_ID),
      parserVersionFrom: 1,
      targetParserVersion: 2,
      sourceRawS3Key: OLD_RAW_KEY,
      claimReadmission: 0,
    } as const satisfies BackgroundReplayBatch;
    const report = {
      id: batch.decisionId,
      caseNumber: "fixture",
      language: "en",
      outcome: REPLAY_ROW_OUTCOME.REJECTED,
      rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      replayedSourceRawS3Key: OLD_RAW_KEY,
    } as const satisfies ReplayRowReport;
    await db.transaction(async (tx) => {
      const decision = (
        await tx
          .select({
            parserVersion: caseLawDecisions.parserVersion,
            sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
            redactedAt: caseLawDecisions.redactedAt,
            corpusMirrorStatus: caseLawDecisions.corpusMirrorStatus,
            parsedInputCurrent: parsedReplayInputPredicate(2),
            readmissionEligible: replayReadmissionInputPredicate(2),
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, batch.decisionId))
          .for("update")
          .limit(1)
      ).at(0);
      let recorded = 0;
      const recordReceipt = async (
        receipt: typeof caseLawReplayBlocked.$inferInsert,
      ) => {
        recorded += 1;
        await tx
          .insert(caseLawReplayBlocked)
          .values(receipt)
          .onConflictDoNothing();
      };
      const stale = await completeReplayReceipt({
        recordReceipt,
        batch,
        report,
        decision,
      });
      expect(stale.type).toBe("retryable");
      expect(recorded).toBe(0);
      const current = await completeReplayReceipt({
        recordReceipt,
        batch: { ...batch, sourceRawS3Key: NEW_RAW_KEY },
        report: { ...report, replayedSourceRawS3Key: NEW_RAW_KEY },
        decision,
      });
      expect(current.type).toBe("terminal");
      expect(recorded).toBe(1);
    });
    const receipt = (
      await db
        .select({ key: caseLawReplayBlocked.sourceRawS3Key })
        .from(caseLawReplayBlocked)
    ).at(0);
    expect(receipt?.key).toBe(NEW_RAW_KEY);
    expect(await eligibleIds(db)).toEqual([]);
  } finally {
    await client.close();
  }
});
