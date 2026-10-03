import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import {
  billingArrangements,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;
let scopedQuery: Awaited<ReturnType<typeof getRlsFixture>>["scopedQuery"];
const matterA = createSafeId<"workspace">();
const otherMatterA = createSafeId<"workspace">();
const matterB = createSafeId<"workspace">();
const matterIds = [matterA, otherMatterA, matterB];

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  scopedQuery = fixture.scopedQuery;
  await testDb.insert(workspaces).values([
    {
      id: matterA,
      organizationId: ids.orgA,
      name: "Arrangement scope A",
      reference: matterA,
    },
    {
      id: otherMatterA,
      organizationId: ids.orgA,
      name: "Arrangement scope A other",
      reference: otherMatterA,
    },
    {
      id: matterB,
      organizationId: ids.orgB,
      name: "Arrangement scope B",
      reference: matterB,
    },
  ]);
  await testDb.insert(workspaceMembers).values([
    { workspaceId: matterA, userId: ids.userA1 },
    { workspaceId: otherMatterA, userId: ids.userA1 },
    { workspaceId: matterB, userId: ids.userB1 },
  ]);
  await testDb.insert(billingArrangements).values([
    {
      workspaceId: matterA,
      organizationId: ids.orgA,
      mode: "hourly",
      currency: "USD",
      capAmount: cents(10_000),
      alertThresholdBps: 8000,
    },
    {
      workspaceId: otherMatterA,
      organizationId: ids.orgA,
      mode: "hourly",
      currency: "USD",
      capAmount: cents(10_000),
      alertThresholdBps: 8000,
    },
    {
      workspaceId: matterB,
      organizationId: ids.orgB,
      mode: "hourly",
      currency: "USD",
      capAmount: cents(10_000),
      alertThresholdBps: 8000,
    },
  ]);
});

afterAll(async () => {
  await testDb.delete(workspaces).where(inArray(workspaces.id, matterIds));
  await releaseRlsFixture();
});

describe("billing arrangement scope", () => {
  test("a narrowed matter scope reads and updates its arrangement", async () => {
    const rows = await scopedQuery(
      [matterA],
      ids.orgA,
      async (tx) =>
        await tx
          .select({ workspaceId: billingArrangements.workspaceId })
          .from(billingArrangements),
      ids.userA1,
    );
    expect(rows).toEqual([{ workspaceId: matterA }]);
    const changed = await scopedQuery(
      [matterA],
      ids.orgA,
      async (tx) =>
        await tx
          .update(billingArrangements)
          .set({ capAmount: cents(12_000) })
          .where(eq(billingArrangements.workspaceId, matterA))
          .returning({ workspaceId: billingArrangements.workspaceId }),
      ids.userA1,
    );
    expect(changed).toEqual([{ workspaceId: matterA }]);
  });

  test("read and update require both the matter and organization scope", async () => {
    for (const denied of [
      { scope: [matterA], target: otherMatterA },
      { scope: [matterB], target: matterB },
      { scope: [matterA, matterB], target: matterB },
    ]) {
      const result = await scopedQuery(
        denied.scope,
        ids.orgA,
        async (tx) => ({
          read: await tx
            .select({ workspaceId: billingArrangements.workspaceId })
            .from(billingArrangements)
            .where(eq(billingArrangements.workspaceId, denied.target)),
          update: await tx
            .update(billingArrangements)
            .set({ capAmount: cents(13_000) })
            .where(eq(billingArrangements.workspaceId, denied.target))
            .returning({ workspaceId: billingArrangements.workspaceId }),
        }),
        ids.userA1,
      );
      expect(result).toEqual({ read: [], update: [] });
    }
    const rows = await testDb
      .select({
        workspaceId: billingArrangements.workspaceId,
        capAmount: billingArrangements.capAmount,
      })
      .from(billingArrangements)
      .where(inArray(billingArrangements.workspaceId, [otherMatterA, matterB]));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.capAmount === 10_000)).toBe(true);
  });

  test("every application policy requires matter and organization scope", async () => {
    const policies = await testDb.execute<{
      command: string;
      using: string | null;
      withCheck: string | null;
      appRole: boolean;
    }>(sql`
      SELECT policy.polcmd AS command,
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) AS using,
        pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) AS "withCheck",
        (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'stella') = ANY(policy.polroles) AS "appRole"
      FROM pg_catalog.pg_policy policy
      WHERE policy.polrelid = 'public.billing_arrangements'::regclass
      ORDER BY policy.polcmd
    `);
    expect(policies.rows.map((policy) => policy.command).toSorted()).toEqual([
      "a",
      "d",
      "r",
      "w",
    ]);
    for (const policy of policies.rows) {
      expect(policy.appRole).toBe(true);
      const expression =
        policy.command === "a" ? policy.withCheck : policy.using;
      expect(expression).not.toBeNull();
      expect(expression).toContain("workspace_id");
      expect(expression).toContain("app.workspace_ids");
      expect(expression).toContain("organization_id");
      expect(expression).toContain("app.organization_id");
      if (policy.command === "w") {
        // PostgreSQL reuses USING as WITH CHECK when WITH CHECK is omitted.
        const check = policy.withCheck ?? policy.using;
        expect(check).toContain("app.workspace_ids");
        expect(check).toContain("app.organization_id");
      }
    }
  });

  test("the application role holds the four arrangement table grants", async () => {
    const grants = await testDb.execute<{
      select: boolean;
      insert: boolean;
      update: boolean;
      delete: boolean;
      rls: boolean;
    }>(sql`
      SELECT has_table_privilege('stella', relation.oid, 'SELECT') AS select,
        has_table_privilege('stella', relation.oid, 'INSERT') AS insert,
        has_table_privilege('stella', relation.oid, 'UPDATE') AS update,
        has_table_privilege('stella', relation.oid, 'DELETE') AS delete,
        relation.relrowsecurity AS rls
      FROM pg_catalog.pg_class relation
      WHERE relation.oid = 'public.billing_arrangements'::regclass
    `);
    expect(grants.rows).toEqual([
      { select: true, insert: true, update: true, delete: true, rls: true },
    ]);
  });
});
