import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { billingCodes, rateEntries } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { withTimeBillingEnrolment } from "@/api/tests/helpers/time-billing-enrolment";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import deleteBillingCode from "./delete";

let db: TestDatabase;
let ids: TestIds;
beforeAll(async () => {
  db = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(db, ids);
});
afterAll(async () => await releaseTestDb());

test("referenced activity codes remain until their rate entries are removed", async () => {
  const activityCodeId = createSafeId<"billingCode">();
  const rateEntryId = createSafeId<"rateEntry">();
  await db.insert(billingCodes).values({
    id: activityCodeId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    type: "activity",
    code: "A001",
    label: "Research",
  });
  await db.insert(rateEntries).values({
    id: rateEntryId,
    workspaceId: ids.wsA1,
    rateTableId: ids.rateTableA1,
    activityCodeId,
    hourlyRate: cents(10_000),
    effectiveFrom: "2026-01-01",
  });
  type Context = Parameters<typeof deleteBillingCode.handler>[0];
  const remove = async () =>
    await deleteBillingCode.handler(
      withTimeBillingEnrolment(
        createTestHandlerContext<Context>({
          scopedDb: NO_DB,
          audit: auditRecorderDouble(),
          workspaceId: ids.wsA1,
          session: { activeOrganizationId: ids.orgA },
          user: { id: ids.userA1 },
          safeDb: asTestRaw<SafeDb>(
            createSafeDb(db, [ids.wsA1], ids.orgA, ids.userA1),
          ),
          body: { id: activityCodeId },
        }),
      ),
    );
  expect(await remove()).toMatchObject({
    code: 409,
    response: {
      message: "Remove the activity rates using this code before deleting it",
    },
  });
  expect(
    await db.$count(billingCodes, eq(billingCodes.id, activityCodeId)),
  ).toBe(1);
  await db.delete(rateEntries).where(eq(rateEntries.id, rateEntryId));
  expect(await remove()).toEqual({ deleted: true });
  expect(
    await db.$count(billingCodes, eq(billingCodes.id, activityCodeId)),
  ).toBe(0);
});
