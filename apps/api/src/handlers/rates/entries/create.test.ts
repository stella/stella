import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { rateEntries, rateTables } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { auditRecorderDouble } from "@/api/tests/helpers/audit-recorder-double";
import {
  NO_DB,
  createTestHandlerContext,
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

import createRateEntry from "./create";
import readRateEntries from "./list";
import updateRateEntry from "./update";

let testDb: TestDatabase;
let ids: TestIds;
let rateTableId: SafeId<"rateTable">;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
  rateTableId = toSafeId<"rateTable">(Bun.randomUUIDv7());
  await testDb.insert(rateTables).values({
    id: rateTableId,
    organizationId: ids.orgA,
    workspaceId: ids.wsA1,
    name: "Selector rates",
    currency: "USD",
  });
});
afterAll(async () => await releaseTestDb());

const scopedSafeDb = () =>
  asTestRaw<SafeDb>(createSafeDb(testDb, [ids.wsA1], ids.orgA, ids.userA1));
type CreateContext = Parameters<typeof createRateEntry.handler>[0];
const create = async (body: CreateContext["body"], tableId = rateTableId) =>
  await createRateEntry.handler(
    withTimeBillingEnrolment(
      createTestHandlerContext<CreateContext>({
        scopedDb: NO_DB,
        audit: auditRecorderDouble(),
        workspaceId: ids.wsA1,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: scopedSafeDb(),
        params: { rateTableId: tableId },
        body,
      }),
    ),
  );

type UpdateContext = Parameters<typeof updateRateEntry.handler>[0];
const update = async (body: UpdateContext["body"]) =>
  await updateRateEntry.handler(
    withTimeBillingEnrolment(
      createTestHandlerContext<UpdateContext>({
        scopedDb: NO_DB,
        audit: auditRecorderDouble(),
        workspaceId: ids.wsA1,
        session: { activeOrganizationId: ids.orgA },
        user: { id: ids.userA1 },
        safeDb: scopedSafeDb(),
        params: { rateTableId },
        body,
      }),
    ),
  );

const clearEntries = async () =>
  await testDb
    .delete(rateEntries)
    .where(eq(rateEntries.rateTableId, rateTableId));

const window = {
  hourlyRate: 12_000,
  effectiveFrom: "2025-01-01",
  effectiveTo: "2025-01-31",
};

describe("effective-dated rate selectors", () => {
  test("person, different roles, and single coexist; each refuses overlap within its own selector", async () => {
    await clearEntries();
    const selectors = [
      { userId: ids.userA1 },
      { role: "member" },
      { role: "intern" },
      {},
    ] as const;
    for (const selector of selectors) {
      expect(await create({ ...window, ...selector })).toHaveProperty("id");
      expect(
        await create({
          ...window,
          ...selector,
          effectiveFrom: "2025-01-31",
          effectiveTo: "2025-02-01",
        }),
      ).toMatchObject({ code: 400 });
      expect(
        await create({
          ...window,
          ...selector,
          effectiveFrom: "2025-02-01",
          effectiveTo: "2025-02-28",
        }),
      ).toHaveProperty("id");
    }
    const rows = await testDb
      .select()
      .from(rateEntries)
      .where(eq(rateEntries.rateTableId, rateTableId));
    expect(rows).toHaveLength(8);
    expect(
      rows.filter((row) => row.userId === null && row.role === null),
    ).toHaveLength(2);
    type ListContext = Parameters<typeof readRateEntries.handler>[0];
    const page = await readRateEntries.handler(
      withTimeBillingEnrolment(
        createTestHandlerContext<ListContext>({
          scopedDb: NO_DB,
          audit: auditRecorderDouble(),
          workspaceId: ids.wsA1,
          session: { activeOrganizationId: ids.orgA },
          safeDb: scopedSafeDb(),
          params: { rateTableId },
          query: { limit: 50 },
        }),
      ),
    );
    expect(page).toHaveProperty("items");
    if (!("items" in page)) {
      return;
    }
    expect(page.items.filter((row) => row.role === "member")).toHaveLength(2);
  });

  test("date edits overlap only the same immutable person, role, or single selector", async () => {
    await clearEntries();
    for (const selector of [
      { userId: ids.userA1 },
      { role: "member" },
      {},
    ] as const) {
      const first = await create({ ...window, ...selector });
      expect(first).toHaveProperty("id");
      if (!("id" in first)) {
        return;
      }
      expect(
        await create({
          ...window,
          ...selector,
          effectiveFrom: "2025-03-01",
          effectiveTo: "2025-03-31",
        }),
      ).toHaveProperty("id");
      expect(await update({ id: first.id, effectiveTo: "2025-02-28" })).toEqual(
        { id: first.id },
      );
      expect(
        await update({ id: first.id, effectiveTo: "2025-03-01" }),
      ).toMatchObject({ code: 400 });
      const [row] = await testDb
        .select({ effectiveTo: rateEntries.effectiveTo })
        .from(rateEntries)
        .where(
          and(
            eq(rateEntries.rateTableId, rateTableId),
            eq(rateEntries.id, first.id),
          ),
        );
      expect(row?.effectiveTo).toBe("2025-02-28");
    }
  });

  test("refuses ambiguous selectors and foreign-organization people or tables without writes", async () => {
    await clearEntries();
    expect(
      await create({ ...window, userId: ids.userA1, role: "member" }),
    ).toMatchObject({ code: 400 });
    expect(await create({ ...window, userId: ids.userB1 })).toMatchObject({
      code: 400,
    });
    expect(
      await create({ ...window, role: "member" }, ids.rateTableB1),
    ).toMatchObject({ code: 404 });
    expect(
      await testDb.$count(
        rateEntries,
        eq(rateEntries.rateTableId, rateTableId),
      ),
    ).toBe(0);
  });
});
