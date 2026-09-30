import { panic } from "better-result";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, expenses, timeEntries, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import { buildWipCurrencyQuery, buildWipMatterPageQuery } from "./query";

setDefaultTimeout(120_000);
const ROWS = 2000;
const workspaceId = createSafeId<"workspace">();
const entityId = createSafeId<"entity">();
let db: TestDatabase;
let ids: TestIds;
beforeAll(async () => {
  const fixture = await getRlsFixture();
  db = fixture.testDb;
  ids = fixture.ids;
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId: ids.orgA,
    name: "WIP plan matter",
    reference: workspaceId,
  });
  await db.insert(entities).values({
    id: entityId,
    workspaceId,
    kind: "document",
    name: "WIP plan expense item",
  });
  // Sparse eligibility among same-tenant billing history makes the partial
  // index contract observable rather than relying on tiny empty fixture tables.
  await db.execute(sql`
    INSERT INTO ${timeEntries} (id, organization_id, workspace_id, user_id, date_worked, timezone_id, duration_minutes, billed_minutes, rate_at_entry, currency, narrative, status, billable)
    SELECT gen_random_uuid(), ${ids.orgA}, ${workspaceId}::uuid, ${ids.userAdmin}, DATE '2026-10-01', 'UTC', 1, 1, 31, 'USD', 'WIP plan work', 'approved', i % 50 = 0
    FROM generate_series(1, ${ROWS}::int) i
  `);
  await db.execute(sql`
    INSERT INTO ${expenses} (id, organization_id, workspace_id, user_id, matter_id, date_incurred, amount, currency, category, description, markup, status, billable)
    SELECT gen_random_uuid(), ${ids.orgA}, ${workspaceId}::uuid, ${ids.userAdmin}, ${entityId}::uuid, DATE '2026-10-01', 100, 'USD', 'filing_fee', 'WIP plan expense', 50, 'draft', i % 50 = 0
    FROM generate_series(1, ${ROWS}::int) i
  `);
  await db.execute(sql`ANALYZE ${timeEntries}`);
  await db.execute(sql`ANALYZE ${expenses}`);
});
afterAll(async () => {
  await db.delete(expenses).where(eq(expenses.workspaceId, workspaceId));
  await db.delete(timeEntries).where(eq(timeEntries.workspaceId, workspaceId));
  await db.delete(entities).where(eq(entities.id, entityId));
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
  await releaseRlsFixture();
});
const planText = (explained: unknown) => {
  const rows = isRecord(explained) ? explained["rows"] : explained;
  if (!Array.isArray(rows)) {
    return panic("WIP EXPLAIN returned no rows");
  }
  return rows
    .map((row: unknown) => {
      const text = isRecord(row) ? row["QUERY PLAN"] : undefined;
      return typeof text === "string"
        ? text
        : panic("WIP EXPLAIN row has no plan text");
    })
    .join("\n");
};

test("production WIP currency and matter reads use tenant-leading eligible billing indexes", async () => {
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(db, [workspaceId], ids.orgA, ids.userAdmin),
  );
  const result = await safeDb(async (tx) => {
    // Like the owning find-plan guard, force the offered access path rather
    // than the cost preference of a 2000-row development fixture.
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const options = {
      organizationId: ids.orgA,
      matterId: workspaceId,
      asOf: "2026-10-01",
    };
    const totals = buildWipCurrencyQuery(tx, options);
    const page = buildWipMatterPageQuery(tx, { ...options, limit: 1 });
    const totalsPlan = planText(
      await tx.execute(
        sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${totals.getSQL()}`,
      ),
    );
    const pagePlan = planText(
      await tx.execute(
        sql`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${page.getSQL()}`,
      ),
    );
    return { totalsPlan, pagePlan, totals: await totals, page: await page };
  });
  if (result.isErr()) {
    panic(`WIP plan query failed: ${JSON.stringify(result.error)}`);
  }
  for (const plan of [result.value.totalsPlan, result.value.pagePlan]) {
    expect(plan).toContain("time_entries_org_workspace_wip_idx");
    expect(plan).toContain("expenses_org_workspace_wip_idx");
    expect(plan).not.toMatch(/Seq Scan on (time_entries|expenses)/u);
  }
  expect(result.value.totals).toMatchObject([
    {
      currency: "USD",
      timeAmount: "40",
      expenseAmount: "6000",
      totalAmount: "6040",
    },
  ]);
  expect(result.value.page).toHaveLength(1);
});
