import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  USAGE_ENTITLEMENT_STATUSES,
  usageAllocations,
  usageEntitlements,
  usagePolicies,
} from "@/api/db/schema";
import type { UsageEntitlementStatus } from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { assertUsageAvailable } from "@/api/lib/usage/usage-ledger";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import getEntitlement from "./get-entitlement";

setDefaultTimeout(120_000);

// Statuses under which the org may consume units; every other status blocks
// consumption even with a positive balance. Mirrors CONSUMABLE_STATUSES in
// usage-ledger.ts.
const CONSUMABLE: ReadonlySet<UsageEntitlementStatus> = new Set([
  "active",
  "trialing",
]);

const ALLOCATED_UNITS = 10;
const DAY_MS = 86_400_000;
// The handler reads remaining units `asOf` now, so the allocation period must
// cover the present instant; the boundary tests pin `asOf` explicitly.
const PERIOD_START = new Date(Date.now() - 10 * DAY_MS);
const PERIOD_END = new Date(Date.now() + 20 * DAY_MS);
// An instant inside the allocation period, used as the balance `asOf`.
const AS_OF = new Date();

let testDb: TestDatabase;
let ids: TestIds;
let policyId: SafeId<"usagePolicy">;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  policyId = toSafeId<"usagePolicy">(Bun.randomUUIDv7());
  await testDb.insert(usagePolicies).values({
    id: policyId,
    policyKey: `test_policy_${Bun.randomUUIDv7().replaceAll("-", "").slice(0, 16)}`,
    displayName: "Test policy",
    monthlyUsageUnits: 1000,
  });

  // One entitlement for orgA (unique per org). orgB is deliberately left
  // without an entitlement to exercise the no-entitlement path.
  await testDb.insert(usageEntitlements).values({
    id: toSafeId<"usageEntitlement">(Bun.randomUUIDv7()),
    organizationId: ids.orgA,
    usagePolicyId: policyId,
    status: "active",
    seats: 5,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    source: "manual",
  });

  await testDb.insert(usageAllocations).values({
    id: toSafeId<"usageAllocation">(Bun.randomUUIDv7()),
    organizationId: ids.orgA,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    units: ALLOCATED_UNITS,
    reason: "manual",
    sourceType: "admin",
    sourceRef: null,
  });
});

afterAll(async () => {
  await releaseTestDb();
});

const setEntitlementStatus = async (status: UsageEntitlementStatus) => {
  await testDb
    .update(usageEntitlements)
    .set({ status })
    .where(eq(usageEntitlements.organizationId, ids.orgA));
};

// PGlite's transaction type is structurally distinct from the production
// `Transaction` (different QueryResultHKT); asTestRaw is the established cast
// for bridging a PGlite-backed tx into prod-typed lib functions.
const assertForOrgA = async (required: number, asOf = AS_OF) => {
  const scoped = createScopedDb(testDb, [], ids.orgA, ids.userAdmin);
  return await scoped(async (tx) =>
    assertUsageAvailable({
      tx: asTestRaw<Transaction>(tx),
      organizationId: ids.orgA,
      required,
      asOf,
    }),
  );
};

describe("usage entitlement gating boundary", () => {
  test("passes when available exactly equals the required units", async () => {
    await setEntitlementStatus("active");
    const result = await assertForOrgA(ALLOCATED_UNITS);
    expect(result).toEqual({ ok: true, available: ALLOCATED_UNITS });
  });

  test("rejects when required is one unit over the available balance", async () => {
    await setEntitlementStatus("active");
    const result = await assertForOrgA(ALLOCATED_UNITS + 1);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.error.reason).toBe("usage_limit_exceeded");
    expect(result.error.available).toBe(ALLOCATED_UNITS);
    expect(result.error.required).toBe(ALLOCATED_UNITS + 1);
  });

  test("passes a zero-cost request even against an exhausted balance", async () => {
    await setEntitlementStatus("active");
    // asOf outside the allocation period => available 0, but required 0.
    const result = await assertForOrgA(0, PERIOD_END);
    expect(result).toEqual({ ok: true, available: 0 });
  });

  test("counts no balance once asOf reaches the period end (exclusive)", async () => {
    await setEntitlementStatus("active");
    const result = await assertForOrgA(1, PERIOD_END);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.error.reason).toBe("usage_limit_exceeded");
    expect(result.error.available).toBe(0);
  });

  test("rejects an organization with no entitlement", async () => {
    const scoped = createScopedDb(testDb, [], ids.orgB, ids.userB1);
    const result = await scoped(async (tx) =>
      assertUsageAvailable({
        tx: asTestRaw<Transaction>(tx),
        organizationId: ids.orgB,
        required: 1,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected rejection");
    }
    expect(result.error.reason).toBe("no_entitlement");
  });

  // Every entitlement status the schema distinguishes gets the boundary case:
  // consumable statuses reach the balance check, the rest block regardless of
  // balance.
  for (const status of USAGE_ENTITLEMENT_STATUSES) {
    test(`status "${status}": ${CONSUMABLE.has(status) ? "consumes" : "blocks"} against a full balance`, async () => {
      await setEntitlementStatus(status);
      try {
        const result = await assertForOrgA(1);
        if (CONSUMABLE.has(status)) {
          expect(result).toEqual({ ok: true, available: ALLOCATED_UNITS });
        } else {
          expect(result.ok).toBe(false);
          if (result.ok) {
            throw new Error("expected rejection");
          }
          expect(result.error.reason).toBe("entitlement_inactive");
        }
      } finally {
        await setEntitlementStatus("active");
      }
    });
  }
});

describe("get-entitlement handler", () => {
  type EntitlementCtx = Parameters<typeof getEntitlement.handler>[0];

  const contextFor = (role: "owner" | "member"): EntitlementCtx =>
    createTestHandlerContext<EntitlementCtx>({
      memberRole: { role },
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userAdmin },
      safeDb: asTestRaw<SafeDb>(
        createSafeDb(testDb, [], ids.orgA, ids.userAdmin),
      ),
    });

  test("returns entitlement, policy, and remaining units for a manager", async () => {
    await setEntitlementStatus("active");
    const result = await getEntitlement.handler(contextFor("owner"));
    expect(result).toMatchObject({
      entitlement: { status: "active", seats: 5, source: "manual" },
      policy: { id: policyId, monthlyUsageUnitsPerSeat: 1000 },
      remainingUsageUnits: ALLOCATED_UNITS,
    });
  });

  test("forbids a non-manager role", async () => {
    const result = await getEntitlement.handler(contextFor("member"));
    expect(result).toMatchObject({ code: 403 });
  });
});
