import { expect, test } from "bun:test";

import { CASE_LAW_MAINTENANCE_LANE } from "@/api/lib/case-law/maintenance-lane";

import {
  CORPUS_SCHEMA_LANE,
  CORPUS_SCHEMA_LANE_LOCK_SQL,
  CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
  isCorpusSchemaLaneGranted,
} from "./corpus-schema-lane";

test("the schema lane is its own key, apart from the operator lane", () => {
  expect(CORPUS_SCHEMA_LANE.domain).toBe(CASE_LAW_MAINTENANCE_LANE.domain);
  expect(CORPUS_SCHEMA_LANE.lane).not.toBe(CASE_LAW_MAINTENANCE_LANE.lane);
});

test("the shared side is a transaction-scoped try and the exclusive side is a session pair", () => {
  const key = `hashtext('${CORPUS_SCHEMA_LANE.domain}'), hashtext('${CORPUS_SCHEMA_LANE.lane}')`;
  // A try, never a wait: a transaction blocked on the lane would hold a
  // snapshot that a concurrent index build in the upgrade waits on.
  expect(CORPUS_SCHEMA_LANE_TRY_SHARED_XACT_SQL).toBe(
    `SELECT pg_try_advisory_xact_lock_shared(${key}) AS "granted"`,
  );
  expect(CORPUS_SCHEMA_LANE_LOCK_SQL).toBe(`SELECT pg_advisory_lock(${key})`);
  expect(CORPUS_SCHEMA_LANE_UNLOCK_SQL).toBe(
    `SELECT pg_advisory_unlock(${key})`,
  );
});

test("a try result is granted only when its row says so, under either driver shape", () => {
  expect(isCorpusSchemaLaneGranted([{ granted: true }])).toBe(true);
  expect(isCorpusSchemaLaneGranted({ rows: [{ granted: true }] })).toBe(true);
  expect(isCorpusSchemaLaneGranted([{ granted: false }])).toBe(false);
  expect(isCorpusSchemaLaneGranted([{ granted: "t" }])).toBe(false);
  expect(isCorpusSchemaLaneGranted([])).toBe(false);
  expect(isCorpusSchemaLaneGranted(undefined)).toBe(false);
});
