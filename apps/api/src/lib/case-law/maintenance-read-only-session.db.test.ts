import { afterAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";
import { createTestState } from "@stll/test-state";

import { stellaIngestion } from "@/api/db/rls";
import type { Transaction } from "@/api/db/root";
import { envBase } from "@/api/env-base";
import { openCaseLawReadOnlySession } from "@/api/lib/case-law/maintenance-lane";
import { executedRows } from "@/api/lib/db/executed-rows";
import { UNSAFE_DATABASE_LOGIN_LOCAL_DEV_ENV } from "@/api/lib/db/rls-role-posture";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import {
  initAgentAuthTestDb,
  releaseAgentAuthTestDb,
} from "@/api/tests/helpers/mock-agent-auth-db";

const testState = createTestState({ file: import.meta.path, config: envBase });

beforeEach(() => {
  testState.setConfig(UNSAFE_DATABASE_LOGIN_LOCAL_DEV_ENV, "1");
});

testState.beforeAll(async () => {
  await initAgentAuthTestDb();
});

afterAll(async () => {
  await releaseAgentAuthTestDb();
});

const inspectSnapshot = async (tx: Transaction) => {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
  return executedRows(
    await tx.execute(sql`SELECT
      current_setting('transaction_isolation') AS isolation,
      current_setting('transaction_read_only') AS read_only,
      current_user AS role`),
  ).at(0);
};

test("the default read-only door permits snapshot isolation before either handle reads", async () => {
  const { rootDb, ingestionDb } = await openCaseLawReadOnlySession();
  expect(await rootDb.transaction(inspectSnapshot)).toMatchObject({
    isolation: "repeatable read",
    read_only: "on",
  });
  expect(await ingestionDb(inspectSnapshot)).toEqual({
    isolation: "repeatable read",
    read_only: "on",
    role: stellaIngestion.name,
  });
});

test("the default read-only door rejects mutations through both handles", async () => {
  const { rootDb, ingestionDb } = await openCaseLawReadOnlySession();
  const write = sql`UPDATE case_law_sources SET last_sync_at = now() WHERE false`;
  const rootFailure = await rejectionOf(rootDb.execute(write));
  const ingestionFailure = await rejectionOf(
    ingestionDb(async (tx) => await tx.execute(write)),
  );
  expect(getPgErrorCode(rootFailure)).toBe(PG_ERROR.READ_ONLY_SQL_TRANSACTION);
  expect(getPgErrorCode(ingestionFailure)).toBe(
    PG_ERROR.READ_ONLY_SQL_TRANSACTION,
  );
});
