import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { rateEntries, rateTables } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import updateRateTableHandler from "./update";

/**
 * A rate table's currency is the currency of every rate under it, so changing
 * the code has to move the rates too: the stored integer is minor units, and
 * how many make a major one is a property of the currency. Only a real
 * database shows the rewrite, which happens in the handler's transaction.
 */

let testDb: TestDatabase;
let ids: TestIds;
let rateTableId: SafeId<"rateTable">;

const USD_HOURLY_RATE = 10_000;
const USER_HOURLY_RATE = 25_050;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  rateTableId = toSafeId<"rateTable">(Bun.randomUUIDv7());
  await testDb.insert(rateTables).values({
    id: rateTableId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    name: "Currency change table",
    currency: "USD",
    isDefault: false,
  });
  await testDb.insert(rateEntries).values([
    {
      id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
      workspaceId: ids.wsA1,
      rateTableId,
      userId: null,
      hourlyRate: cents(USD_HOURLY_RATE),
      effectiveFrom: "2024-01-01",
    },
    {
      id: toSafeId<"rateEntry">(Bun.randomUUIDv7()),
      workspaceId: ids.wsA1,
      rateTableId,
      userId: ids.userA1,
      hourlyRate: cents(USER_HOURLY_RATE),
      effectiveFrom: "2024-01-01",
    },
  ]);
}, 60_000);

afterAll(async () => {
  await releaseTestDb();
});

// PGlite's transaction type is structurally distinct from the production
// `Transaction`; asTestRaw is the established bridge for a PGlite-backed
// safeDb in a prod-typed handler context.
const scopedSafeDb = (): SafeDb =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));

type UpdateRateTableCtx = Parameters<typeof updateRateTableHandler.handler>[0];

test("changing a rate table from USD to JPY restates every rate under it", async () => {
  const result = await updateRateTableHandler.handler(
    createTestHandlerContext<UpdateRateTableCtx>({
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      safeDb: scopedSafeDb(),
      body: { id: rateTableId, currency: "JPY" },
    }),
  );
  expect(result).toEqual({ id: rateTableId });

  const rows = await testDb
    .select({ hourlyRate: rateEntries.hourlyRate })
    .from(rateEntries)
    .where(
      and(
        eq(rateEntries.rateTableId, rateTableId),
        eq(rateEntries.workspaceId, ids.wsA1),
      ),
    );

  // $100.00 is 100 yen and $250.50 rounds to 251: JPY counts whole units, so
  // the stored integer drops two decimal places rather than staying as it was.
  expect(rows.map((row) => row.hourlyRate).toSorted((a, b) => a - b)).toEqual([
    100, 251,
  ]);

  const [table] = await testDb
    .select({ currency: rateTables.currency })
    .from(rateTables)
    .where(eq(rateTables.id, rateTableId));
  expect(table?.currency).toBe("JPY");
});
