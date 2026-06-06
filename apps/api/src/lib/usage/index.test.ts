import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { TransactionRollbackError } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { organization, user } from "@/api/db/auth-schema";
import {
  USAGE_ALLOCATION_REASONS,
  USAGE_ALLOCATION_SOURCES,
  usagePolicies,
  usageEntitlements,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  assertUsageAvailable,
  allocateUsage,
  getRemainingUsageUnits,
  recordUsageEvent,
} from "@/api/lib/usage";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

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
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
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
});

describe("usage ledger — enum coverage", () => {
  // Cheap structural test: the typed enum constants we depend on
  // must include the discriminator values the rest of the code
  // hard-codes. If anyone adds a new reason / source and forgets
  // to update the array, this fails before any handler does.
  test("USAGE_ALLOCATION_REASONS includes every value the handlers emit", () => {
    expect(USAGE_ALLOCATION_REASONS).toContain("periodic");
    expect(USAGE_ALLOCATION_REASONS).toContain("addon");
    expect(USAGE_ALLOCATION_REASONS).toContain("manual");
    expect(USAGE_ALLOCATION_REASONS).toContain("promo");
  });

  test("USAGE_ALLOCATION_SOURCES includes every value the handlers emit", () => {
    expect(USAGE_ALLOCATION_SOURCES).toContain("hosted_entitlement");
    expect(USAGE_ALLOCATION_SOURCES).toContain("hosted_allocation");
    expect(USAGE_ALLOCATION_SOURCES).toContain("admin");
    expect(USAGE_ALLOCATION_SOURCES).toContain("scheduler");
  });
});
