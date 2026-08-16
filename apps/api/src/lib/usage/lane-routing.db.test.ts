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
import { usageEntitlements, usagePolicies } from "@/api/db/schema";
import type { UsageEntitlementStatus } from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { incrementLaneCounter } from "@/api/lib/usage/lane-budget";
import {
  decideChatUsageLane,
  FALLBACK_CHAT_MODEL_SELECTION,
} from "@/api/lib/usage/lane-routing";
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

// 2026-07-10 is a Friday inside the seeded period: its daily bucket
// (2026-07-10) and its ISO-week bucket (Monday 2026-07-06) differ, so a
// daily/weekly kind mix-up cannot pass unnoticed.
const ASOF = new Date("2026-07-10T12:00:00.000Z");
const PERIOD_START = new Date("2026-07-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-08-01T00:00:00.000Z");

const DAILY_ALLOWANCE = 1000;
const FALLBACK_WEEKLY = 5000;

type Fixture = {
  organizationId: SafeId<"organization">;
  userId: string;
};

const setupFixture = async (tx: Transaction): Promise<Fixture> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = `user_${Bun.randomUUIDv7()}`;

  await tx.insert(organization).values({
    id: organizationId,
    name: "Test Org",
    slug: organizationId,
    createdAt: ASOF,
  });
  await tx.insert(user).values({
    id: userId,
    name: "Test User",
    email: `${userId}@test.local`,
  });

  return { organizationId, userId };
};

type SeedEntitlementOptions = {
  tx: Transaction;
  fx: Fixture;
  status: UsageEntitlementStatus;
  dailyAllowanceMicroUnits: number | null;
  fallbackWeeklyMicroUnits: number | null;
};

const seedEntitlement = async ({
  tx,
  fx,
  status,
  dailyAllowanceMicroUnits,
  fallbackWeeklyMicroUnits,
}: SeedEntitlementOptions): Promise<void> => {
  const usagePolicyId = createSafeId<"usagePolicy">();

  await tx.insert(usagePolicies).values({
    id: usagePolicyId,
    policyKey: `test_${Bun.randomUUIDv7()}`,
    displayName: "Test Policy",
    monthlyUsageUnits: 10_000,
    dailyAllowanceMicroUnits,
    fallbackWeeklyMicroUnits,
  });
  await tx.insert(usageEntitlements).values({
    id: createSafeId<"usageEntitlement">(),
    organizationId: fx.organizationId,
    usagePolicyId,
    status,
    seats: 1,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    source: "manual",
  });
};

const withRolledBackTx = async (
  fn: (tx: Transaction) => Promise<void>,
): Promise<void> => {
  try {
    await testDb.transaction(async (rawTx) => {
      // SAFETY: PGlite drizzle transaction is structurally compatible
      // with prod BunSQL transaction for the queries we run here.
      const tx = asTestRaw<Transaction>(rawTx);
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

describe("chat usage lane routing", () => {
  test("an org without an entitlement row draws from the pool", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);

      expect(await decideChatUsageLane({ tx, ...fx, asOf: ASOF })).toEqual({
        lane: "pool",
      });
    });
  });

  test("a policy that declares no daily allowance draws from the pool", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      // A weekly fallback alone grants no lane: the daily allowance is
      // the opt-in.
      await seedEntitlement({
        tx,
        fx,
        status: "active",
        dailyAllowanceMicroUnits: null,
        fallbackWeeklyMicroUnits: FALLBACK_WEEKLY,
      });

      expect(await decideChatUsageLane({ tx, ...fx, asOf: ASOF })).toEqual({
        lane: "pool",
      });
    });
  });

  test("a non-consumable entitlement draws from the pool despite seeded budgets", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedEntitlement({
        tx,
        fx,
        status: "cancelled",
        dailyAllowanceMicroUnits: DAILY_ALLOWANCE,
        fallbackWeeklyMicroUnits: FALLBACK_WEEKLY,
      });

      expect(await decideChatUsageLane({ tx, ...fx, asOf: ASOF })).toEqual({
        lane: "pool",
      });
    });
  });

  test("a daily counter below the allowance draws from the allowance", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedEntitlement({
        tx,
        fx,
        status: "active",
        dailyAllowanceMicroUnits: DAILY_ALLOWANCE,
        fallbackWeeklyMicroUnits: FALLBACK_WEEKLY,
      });

      // An untouched bucket has no row; the missing row must read as
      // zero rather than skipping the lane.
      expect(await decideChatUsageLane({ tx, ...fx, asOf: ASOF })).toEqual({
        lane: "allowance",
      });

      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: DAILY_ALLOWANCE - 1,
        asOf: ASOF,
      });
      expect(await decideChatUsageLane({ tx, ...fx, asOf: ASOF })).toEqual({
        lane: "allowance",
      });
    });
  });

  test("an exhausted daily budget with weekly room forces the fallback model", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedEntitlement({
        tx,
        fx,
        status: "active",
        dailyAllowanceMicroUnits: DAILY_ALLOWANCE,
        fallbackWeeklyMicroUnits: FALLBACK_WEEKLY,
      });

      // The allowance is spent at equality, not only past it.
      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: DAILY_ALLOWANCE,
        asOf: ASOF,
      });
      expect(await decideChatUsageLane({ tx, ...fx, asOf: ASOF })).toEqual({
        lane: "fallback",
        forcedModelSelection: FALLBACK_CHAT_MODEL_SELECTION,
      });

      // Overshooting the daily budget (a turn that crossed it) keeps the
      // same lane while the weekly budget still has room.
      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: DAILY_ALLOWANCE,
        asOf: ASOF,
      });
      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "fallback_weekly",
        microUnits: FALLBACK_WEEKLY - 1,
        asOf: ASOF,
      });
      expect(await decideChatUsageLane({ tx, ...fx, asOf: ASOF })).toEqual({
        lane: "fallback",
        forcedModelSelection: FALLBACK_CHAT_MODEL_SELECTION,
      });
    });
  });

  test("an exhausted daily budget draws from the pool when the policy grants no weekly fallback", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedEntitlement({
        tx,
        fx,
        status: "active",
        dailyAllowanceMicroUnits: DAILY_ALLOWANCE,
        fallbackWeeklyMicroUnits: null,
      });

      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: DAILY_ALLOWANCE,
        asOf: ASOF,
      });
      expect(await decideChatUsageLane({ tx, ...fx, asOf: ASOF })).toEqual({
        lane: "pool",
      });
    });
  });

  test("both budgets exhausted draws from the pool", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedEntitlement({
        tx,
        fx,
        status: "active",
        dailyAllowanceMicroUnits: DAILY_ALLOWANCE,
        fallbackWeeklyMicroUnits: FALLBACK_WEEKLY,
      });

      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "daily",
        microUnits: DAILY_ALLOWANCE,
        asOf: ASOF,
      });
      await incrementLaneCounter({
        tx,
        ...fx,
        kind: "fallback_weekly",
        microUnits: FALLBACK_WEEKLY,
        asOf: ASOF,
      });
      expect(await decideChatUsageLane({ tx, ...fx, asOf: ASOF })).toEqual({
        lane: "pool",
      });
    });
  });
});
