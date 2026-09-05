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
let defaultEntryId: SafeId<"rateEntry">;

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
  defaultEntryId = toSafeId<"rateEntry">(Bun.randomUUIDv7());
  await testDb.insert(rateEntries).values([
    {
      id: defaultEntryId,
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
    cents(100),
    cents(251),
  ]);

  const [table] = await testDb
    .select({ currency: rateTables.currency })
    .from(rateTables)
    .where(eq(rateTables.id, rateTableId));
  expect(table?.currency).toBe("JPY");
});

test("the scale reads each row's current value, not one read earlier", async () => {
  // The defect a per-row CASE has: the new value is computed from a SELECT
  // taken before the write, so a rate changed in between is overwritten with
  // what it used to be. Writing the row after the handler's own pre-read and
  // before its mutation reproduces exactly that ordering without needing two
  // concurrent transactions.
  //
  // Start from JPY explicitly rather than from whatever the test above left,
  // so the conversion to KWD is three decimals from zero, a shift of +3.
  await testDb
    .update(rateTables)
    .set({ currency: "JPY" })
    .where(eq(rateTables.id, rateTableId));
  await testDb
    .update(rateEntries)
    .set({ hourlyRate: cents(7) })
    .where(eq(rateEntries.id, defaultEntryId));

  const result = await updateRateTableHandler.handler(
    createTestHandlerContext<UpdateRateTableCtx>({
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      safeDb: scopedSafeDb(),
      body: { id: rateTableId, currency: "KWD" },
    }),
  );
  expect(result).toEqual({ id: rateTableId });

  const [row] = await testDb
    .select({ hourlyRate: rateEntries.hourlyRate })
    .from(rateEntries)
    .where(eq(rateEntries.id, defaultEntryId));
  // 7 yen is 7.000 dinars: the value in the database when the statement ran,
  // scaled by the exponent difference, not the 100 this row held before.
  expect(row?.hourlyRate).toBe(cents(7000));
});

test("refuses a currency change whose scaled rate leaves the safe range", async () => {
  // Zero decimals to three multiplies by a thousand. This rate is a fine
  // integer on its own and its scaled value is not: the column is bigint and
  // would store it, but the API hands it back as a JSON number, past which
  // point the amount stops naming itself.
  const beyondRange = Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1;
  await testDb
    .update(rateEntries)
    .set({ hourlyRate: cents(beyondRange) })
    .where(eq(rateEntries.id, defaultEntryId));
  await testDb
    .update(rateTables)
    .set({ currency: "JPY" })
    .where(eq(rateTables.id, rateTableId));

  const result = await updateRateTableHandler.handler(
    createTestHandlerContext<UpdateRateTableCtx>({
      workspaceId: ids.wsA1,
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      safeDb: scopedSafeDb(),
      body: { id: rateTableId, currency: "KWD" },
    }),
  );
  expect(result).toMatchObject({ code: 400 });

  // Refused before any write: the rate and the table's currency are untouched.
  const [row] = await testDb
    .select({ hourlyRate: rateEntries.hourlyRate })
    .from(rateEntries)
    .where(eq(rateEntries.id, defaultEntryId));
  expect(row?.hourlyRate).toBe(cents(beyondRange));
  const [table] = await testDb
    .select({ currency: rateTables.currency })
    .from(rateTables)
    .where(eq(rateTables.id, rateTableId));
  expect(table?.currency).toBe("JPY");
});
