import { expect, test } from "bun:test";

import { CASE_LAW_MAINTENANCE_LANE } from "@/api/lib/case-law/maintenance-lane";

import {
  CORPUS_SCHEMA_LANE,
  CORPUS_SCHEMA_LANE_LOCK_SQL,
  CORPUS_SCHEMA_LANE_SHARED_XACT_SQL,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
} from "./corpus-schema-lane";

test("the schema lane is its own key, apart from the operator lane", () => {
  expect(CORPUS_SCHEMA_LANE.domain).toBe(CASE_LAW_MAINTENANCE_LANE.domain);
  expect(CORPUS_SCHEMA_LANE.lane).not.toBe(CASE_LAW_MAINTENANCE_LANE.lane);
});

test("the shared side is transaction-scoped and the exclusive side is a session pair", () => {
  const key = `hashtext('${CORPUS_SCHEMA_LANE.domain}'), hashtext('${CORPUS_SCHEMA_LANE.lane}')`;
  expect(CORPUS_SCHEMA_LANE_SHARED_XACT_SQL).toBe(
    `SELECT pg_advisory_xact_lock_shared(${key})`,
  );
  expect(CORPUS_SCHEMA_LANE_LOCK_SQL).toBe(`SELECT pg_advisory_lock(${key})`);
  expect(CORPUS_SCHEMA_LANE_UNLOCK_SQL).toBe(
    `SELECT pg_advisory_unlock(${key})`,
  );
});
