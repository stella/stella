import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { TransactionRollbackError } from "drizzle-orm";

import { organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { usagePolicies, usageEntitlements } from "@/api/db/schema";
import type { UsageEntitlementStatus } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  assertUsageAvailable,
  allocateUsage,
  getRemainingUsageUnits,
  isConsumableEntitlementStatus,
  isEntitlementConsumableAt,
  recordUsageEvent,
} from "@/api/lib/usage/usage-ledger";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

type Fixture = {
  organizationId: SafeId<"organization">;
  usagePolicyId: SafeId<"usagePolicy">;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
};

const PERIOD_START = new Date("2026-06-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-07-01T00:00:00.000Z");

const setupFixture = async (
  tx: Transaction,
  overrides: Partial<{ status: "active" | "cancelled" | "paused" }> = {},
): Promise<Fixture> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = `user_${Bun.randomUUIDv7()}`;

  await tx.insert(organization).values({
    id: organizationId,
    name: "Test Org",
    slug: organizationId,
    createdAt: PERIOD_START,
  });

  await tx.insert(user).values({
    id: userId,
    name: "Test User",
    email: `${userId}@test.local`,
  });

  const insertedPlan = await tx
    .insert(usagePolicies)
    .values({
      policyKey: "ledger-test",
      displayName: "Pro",
      monthlyUsageUnits: 8000,
      hostedPolicyRef: `provider_policy_${Bun.randomUUIDv7()}`,
    })
    .returning({ id: usagePolicies.id });

  const usagePolicyId = insertedPlan.at(0)?.id;
  if (!usagePolicyId) {
    throw new Error("Failed to insert test usage policy");
  }

  await tx.insert(usageEntitlements).values({
    organizationId,
    usagePolicyId,
    status: overrides.status ?? "active",
    seats: 5,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    source: "hosted",
  });

  return {
    organizationId,
    usagePolicyId,
    userId,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
  };
};

const withRolledBackTx = async (
  fn: (tx: Transaction) => Promise<void>,
): Promise<void> => {
  try {
    await testDb.transaction(async (rawTx) => {
      // SAFETY: PGlite's drizzle transaction is structurally
      // identical to the prod BunSQL transaction for the
      // INSERT / SELECT operations we use here. The only
      // difference is the driver-result HKT, which has no
      // observable effect on these tests. Casting once at the
      // boundary keeps the usage module honest to its prod
      // Transaction type without importing test-only types.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite vs BunSQL driver-result HKT only; importing test-only types is disallowed
      const tx = rawTx as unknown as Transaction;
      await fn(tx);
      rawTx.rollback();
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) {
      return;
    }
    throw error;
  }
};

const midPeriod = new Date((PERIOD_START.getTime() + PERIOD_END.getTime()) / 2);

describe("usage entitlement consumability", () => {
  test("allows live entitlements and rejects inactive ones", () => {
    expect(isConsumableEntitlementStatus("active")).toBe(true);
    expect(isConsumableEntitlementStatus("trialing")).toBe(true);
    expect(isConsumableEntitlementStatus("cancelled")).toBe(false);
  });

  test("fails closed for a stored status outside the inferred domain", () => {
    expect(
      isConsumableEntitlementStatus(
        asTestRaw<UsageEntitlementStatus>("unknown_status"),
      ),
    ).toBe(false);
  });

  test("uses a start-inclusive, end-exclusive current period", () => {
    const entitlement = {
      status: "active",
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
    } as const;

    expect(
      isEntitlementConsumableAt(
        entitlement,
        new Date(PERIOD_START.getTime() - 1),
      ),
    ).toBe(false);
    expect(isEntitlementConsumableAt(entitlement, PERIOD_START)).toBe(true);
    expect(
      isEntitlementConsumableAt(
        entitlement,
        new Date(PERIOD_END.getTime() - 1),
      ),
    ).toBe(true);
    expect(isEntitlementConsumableAt(entitlement, PERIOD_END)).toBe(false);
  });
});

describe("usage ledger — assertUsageAvailable", () => {
  test("returns no_entitlement when org has no entitlement row", async () => {
    await withRolledBackTx(async (tx) => {
      const orphanOrgId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
      await tx.insert(organization).values({
        id: orphanOrgId,
        name: "Orphan",
        slug: orphanOrgId,
        createdAt: PERIOD_START,
      });
      const result = await assertUsageAvailable({
        tx,
        organizationId: orphanOrgId,
        required: 10,
        asOf: midPeriod,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe("no_entitlement");
        expect(result.error.required).toBe(10);
        expect(result.error.available).toBe(0);
      }
    });
  });

  test("returns entitlement_inactive when entitlement is cancelled", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx, { status: "cancelled" });
      // Allocate units to prove the inactive check overrides balance
      await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 10_000,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_001",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });
      const result = await assertUsageAvailable({
        tx,
        organizationId: fx.organizationId,
        required: 10,
        asOf: midPeriod,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe("entitlement_inactive");
      }
    });
  });

  test("returns usage_limit_exceeded when allocations - usage < required", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 50,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_002",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });
      const result = await assertUsageAvailable({
        tx,
        organizationId: fx.organizationId,
        required: 100,
        asOf: midPeriod,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.reason).toBe("usage_limit_exceeded");
        expect(result.error.required).toBe(100);
        expect(result.error.available).toBe(50);
      }
    });
  });

  test("returns ok with available balance when sufficient", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 1000,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_003",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });
      const result = await assertUsageAvailable({
        tx,
        organizationId: fx.organizationId,
        required: 200,
        asOf: midPeriod,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.available).toBe(1000);
      }
    });
  });
});

describe("usage ledger — allocation + usage math", () => {
  test("balance = SUM(allocations) - SUM(consumption) within active period", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 2000,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_grant_a",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });
      await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 500,
        reason: "addon",
        sourceType: "hosted_allocation",
        sourceRef: "evt_grant_b",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });
      await recordUsageEvent({
        tx,
        organizationId: fx.organizationId,
        workspaceId: null,
        userId: fx.userId,
        actionType: "doc_review",
        modelRole: "fast",
        unitsConsumed: 300,
        serviceTier: "flex",
        isByok: false,
      });
      await recordUsageEvent({
        tx,
        organizationId: fx.organizationId,
        workspaceId: null,
        userId: fx.userId,
        actionType: "chat",
        modelRole: "chat",
        unitsConsumed: 200,
        serviceTier: "standard",
        isByok: false,
      });

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: midPeriod,
      });
      // 2000 + 500 - 300 - 200 = 2000
      expect(balance).toBe(2000);
    });
  });

  test("only pool-lane events settle against allocated units", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 1000,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_lane_exclusion",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });

      const laneEvent = {
        tx,
        organizationId: fx.organizationId,
        workspaceId: null,
        userId: fx.userId,
        actionType: "chat",
        modelRole: "chat",
        serviceTier: "standard",
        isByok: false,
        period: { start: fx.periodStart, end: fx.periodEnd },
      } as const;

      // Allowance and fallback turns carry their consumption as raw
      // micro-units and are settled by the per-user lane counters, so the
      // org's purchased units must not move for them.
      for (const lane of ["allowance", "fallback"] as const) {
        await recordUsageEvent({
          ...laneEvent,
          lane,
          unitsConsumed: 0,
          rawUsageMicroUnits: 4500,
        });
      }

      expect(
        await getRemainingUsageUnits({
          tx,
          organizationId: fx.organizationId,
          asOf: midPeriod,
        }),
      ).toBe(1000);

      await recordUsageEvent({
        ...laneEvent,
        lane: "pool",
        unitsConsumed: 250,
      });

      expect(
        await getRemainingUsageUnits({
          tx,
          organizationId: fx.organizationId,
          asOf: midPeriod,
        }),
      ).toBe(750);
    });
  });

  test("sums allocations beyond PostgreSQL's int4 range", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      for (const [sourceRef, units] of [
        ["evt_large_allocation_a", 1_500_000_000],
        ["evt_large_allocation_b", 1_500_000_000],
      ] as const) {
        await allocateUsage({
          tx,
          organizationId: fx.organizationId,
          units,
          reason: "periodic",
          sourceType: "hosted_entitlement",
          sourceRef,
          period: { start: fx.periodStart, end: fx.periodEnd },
        });
      }

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: midPeriod,
      });
      expect(balance).toBe(3_000_000_000);
    });
  });

  test("sums consumption beyond PostgreSQL's int4 range", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      for (const actionType of ["doc_review", "chat"] as const) {
        await recordUsageEvent({
          tx,
          organizationId: fx.organizationId,
          workspaceId: null,
          userId: fx.userId,
          actionType,
          modelRole: "fast",
          unitsConsumed: 1_500_000_000,
          serviceTier: "flex",
          isByok: false,
        });
      }

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: midPeriod,
      });
      expect(balance).toBe(-3_000_000_000);
    });
  });

  test("allocations outside the active period are excluded from balance", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      // Previous-period allocation: should not count when querying current period.
      const previousStart = new Date("2026-05-01T00:00:00.000Z");
      const previousEnd = new Date("2026-06-01T00:00:00.000Z");
      await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 9999,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_prev_period",
        period: { start: previousStart, end: previousEnd },
      });
      await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 100,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_cur_period",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: midPeriod,
      });
      expect(balance).toBe(100);
    });
  });
});

describe("usage ledger — idempotency", () => {
  test("duplicate sourceRef returns duplicate status and does not double-allocate", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const first = await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 1000,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_dup",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });
      expect(first.status).toBe("allocated");

      const second = await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 1000,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_dup",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });
      expect(second.status).toBe("duplicate");

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: midPeriod,
      });
      expect(balance).toBe(1000);
    });
  });

  test("null sourceRef allows multiple inserts (no idempotency target)", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const a = await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 100,
        reason: "manual",
        sourceType: "admin",
        sourceRef: null,
        period: { start: fx.periodStart, end: fx.periodEnd },
      });
      const b = await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 200,
        reason: "manual",
        sourceType: "admin",
        sourceRef: null,
        period: { start: fx.periodStart, end: fx.periodEnd },
      });
      expect(a.status).toBe("allocated");
      expect(b.status).toBe("allocated");

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: midPeriod,
      });
      expect(balance).toBe(300);
    });
  });

  test("duplicate usage idempotency keys do not double-consume units", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await allocateUsage({
        tx,
        organizationId: fx.organizationId,
        units: 1000,
        reason: "periodic",
        sourceType: "hosted_entitlement",
        sourceRef: "evt_usage_idempotency",
        period: { start: fx.periodStart, end: fx.periodEnd },
      });

      const input = {
        tx,
        organizationId: fx.organizationId,
        workspaceId: null,
        userId: fx.userId,
        actionType: "chat",
        modelRole: "chat",
        unitsConsumed: 100,
        serviceTier: "standard",
        isByok: false,
        idempotencyKey: "trace_usage_idempotency",
        traceId: "trace_usage_idempotency",
        period: { start: fx.periodStart, end: fx.periodEnd },
      } as const;

      const first = await recordUsageEvent(input);
      const second = await recordUsageEvent(input);

      expect(first.status).toBe("recorded");
      expect(second.status).toBe("duplicate");

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: midPeriod,
      });
      expect(balance).toBe(900);
    });
  });
});
