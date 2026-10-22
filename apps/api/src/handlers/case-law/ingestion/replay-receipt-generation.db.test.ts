import { PGlite } from "@electric-sql/pglite";
import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawReplayBlocked,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { STORED_RAW_REPARSE_REJECTION } from "@/api/lib/legal-search/ingestion-types";

import { repairCaseLawReplayReceiptBatch } from "../../../db/case-law-replay-receipt-repair";
import type { BackgroundReplayBatch } from "./background-replay";
import { completeReplayReceipt } from "./background-replay-store";
import {
  REPLAY_ROW_OUTCOME,
  replaySelectionPredicate,
  type ReplayRowReport,
} from "./replay";

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const DECISION_ID = "00000000-0000-4000-8000-000000000011";
const OLD_HASH = "a".repeat(64);
const NEW_HASH = "b".repeat(64);

const SCHEMA = `
CREATE TABLE case_law_sources (id uuid PRIMARY KEY);
CREATE TABLE case_law_decisions (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES case_law_sources(id),
  parser_version integer,
  source_raw_s3_key text,
  source_hash varchar(64),
  redacted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  corpus_mirror_status text NOT NULL DEFAULT 'settled'
);
CREATE TABLE case_law_replay_batches (
  id text PRIMARY KEY,
  source_id uuid NOT NULL,
  first_decision_id uuid NOT NULL,
  parser_version_to integer NOT NULL,
  outcome text
);
CREATE TABLE case_law_replay_blocked (
  source_id uuid NOT NULL REFERENCES case_law_sources(id),
  decision_id uuid NOT NULL,
  source_hash varchar(64),
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
      (id, source_id, parser_version, source_raw_s3_key, source_hash)
    VALUES ('${DECISION_ID}', '${SOURCE_ID}', 1, 'raw/decision', '${OLD_HASH}');
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

test("legacy and repaired receipts block only their raw generation", async () => {
  const { client, db } = await createDatabase();
  await client.exec(`
    INSERT INTO case_law_replay_blocked
      (source_id, decision_id, source_hash, parser_version_from, parser_version_to, outcome)
    VALUES ('${SOURCE_ID}', '${DECISION_ID}', NULL, 1, 2, 'unchanged');
  `);

  expect(await eligibleIds(db)).toEqual([]);

  const connection = {
    execute: async (query: string, params: readonly unknown[] = []) => {
      await client.query(query, [...params]);
    },
    query: async (query: string, params: readonly unknown[] = []) =>
      (await client.query(query, [...params])).rows,
  };
  await repairCaseLawReplayReceiptBatch(connection, null, 10);
  expect(await eligibleIds(db)).toEqual([]);

  await db
    .update(caseLawDecisions)
    .set({ sourceHash: NEW_HASH })
    .where(eq(caseLawDecisions.id, toSafeId(DECISION_ID)));
  expect(await eligibleIds(db)).toEqual([DECISION_ID]);
});

test("a rejected receipt records the raw generation that replay read", async () => {
  const { db } = await createDatabase();
  await db
    .update(caseLawDecisions)
    .set({ sourceHash: NEW_HASH })
    .where(eq(caseLawDecisions.id, toSafeId(DECISION_ID)));

  const batch = {
    id: "receipt-generation",
    source: {
      id: toSafeId<"caseLawSource">(SOURCE_ID),
      adapterKey: "eu-ecj",
      currentParserVersion: 2,
      dailyBudget: 1,
      mode: "enrolled",
      rowsBehind: 1,
    },
    decisionId: toSafeId<"caseLawDecision">(DECISION_ID),
    parserVersionFrom: 1,
    targetParserVersion: 2,
  } as const satisfies BackgroundReplayBatch;
  const report = {
    id: batch.decisionId,
    caseNumber: "fixture",
    language: "en",
    outcome: REPLAY_ROW_OUTCOME.REJECTED,
    rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
    replayedSourceHash: OLD_HASH,
  } as const satisfies ReplayRowReport;

  await db.transaction(async (tx) => {
    const completion = await completeReplayReceipt({
      recordReceipt: async (receipt) => {
        await tx
          .insert(caseLawReplayBlocked)
          .values(receipt)
          .onConflictDoNothing();
      },
      batch,
      report,
      decision: {
        parserVersion: 1,
        sourceHash: NEW_HASH,
        redactedAt: null,
        corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.SETTLED,
        updateToken: "newer-decision-row",
      },
    });
    expect(completion.type).toBe("terminal");
  });

  const receipt = (
    await db
      .select({ sourceHash: caseLawReplayBlocked.sourceHash })
      .from(caseLawReplayBlocked)
  ).at(0);
  expect(receipt?.sourceHash).toBe(OLD_HASH);
  expect(await eligibleIds(db)).toEqual([DECISION_ID]);
});
