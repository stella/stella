import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { TransactionRollbackError } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  USAGE_ENTITLEMENT_SOURCES,
  USAGE_ENTITLEMENT_STATUSES,
  usageEntitlements,
  usagePolicies,
} from "@/api/db/schema";
import type {
  UsageEntitlementSource,
  UsageEntitlementStatus,
} from "@/api/db/schema";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { hasRenewingHostedSubscription } from "@/api/lib/usage/renewing-hosted-subscription";
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

const PERIOD_START = new Date("2026-10-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-11-01T00:00:00.000Z");

// Independent oracle: an organization whose provider subscription bills at
// the next renewal cannot be deleted; its owner cancels first.
const REFUSES_DELETION_BY_STATUS = {
  trialing: false,
  active: true,
  past_due: true,
  cancelled: false,
  paused: false,
} as const satisfies Record<UsageEntitlementStatus, boolean>;

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

const seedOrganization = async (
  tx: Transaction,
): Promise<SafeId<"organization">> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  await tx.insert(organization).values({
    id: organizationId,
    name: "Test Org",
    slug: organizationId,
    createdAt: PERIOD_START,
  });
  return organizationId;
};

type SeedEntitlementOptions = {
  tx: Transaction;
  organizationId: SafeId<"organization">;
  status: UsageEntitlementStatus;
  source: UsageEntitlementSource;
  cancelAtPeriodEnd: boolean;
};

const seedEntitlement = async ({
  tx,
  organizationId,
  status,
  source,
  cancelAtPeriodEnd,
}: SeedEntitlementOptions): Promise<void> => {
  const usagePolicyId = createSafeId<"usagePolicy">();
  await tx.insert(usagePolicies).values({
    id: usagePolicyId,
    policyKey: `test_${Bun.randomUUIDv7()}`,
    displayName: "Test Policy",
    monthlyUsageUnits: 0,
  });
  await tx.insert(usageEntitlements).values({
    id: createSafeId<"usageEntitlement">(),
    organizationId,
    usagePolicyId,
    status,
    seats: 1,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    cancelAtPeriodEnd,
    source,
  });
};

describe("renewing hosted subscription", () => {
  test.each(USAGE_ENTITLEMENT_STATUSES)(
    "a hosted %s subscription decides whether deletion is refused",
    async (status) => {
      await withRolledBackTx(async (tx) => {
        const organizationId = await seedOrganization(tx);
        await seedEntitlement({
          tx,
          organizationId,
          status,
          source: "hosted",
          cancelAtPeriodEnd: false,
        });

        expect(await hasRenewingHostedSubscription(tx, organizationId)).toBe(
          REFUSES_DELETION_BY_STATUS[status],
        );
      });
    },
  );

  test.each(USAGE_ENTITLEMENT_STATUSES)(
    "a hosted %s subscription set to cancel at period end allows deletion",
    async (status) => {
      await withRolledBackTx(async (tx) => {
        const organizationId = await seedOrganization(tx);
        await seedEntitlement({
          tx,
          organizationId,
          status,
          source: "hosted",
          cancelAtPeriodEnd: true,
        });

        expect(await hasRenewingHostedSubscription(tx, organizationId)).toBe(
          false,
        );
      });
    },
  );

  test.each(USAGE_ENTITLEMENT_SOURCES.filter((source) => source !== "hosted"))(
    "a %s entitlement never refuses deletion",
    async (source) => {
      await withRolledBackTx(async (tx) => {
        const organizationId = await seedOrganization(tx);
        await seedEntitlement({
          tx,
          organizationId,
          status: "active",
          source,
          cancelAtPeriodEnd: false,
        });

        expect(await hasRenewingHostedSubscription(tx, organizationId)).toBe(
          false,
        );
      });
    },
  );

  test("an organization without an entitlement allows deletion", async () => {
    await withRolledBackTx(async (tx) => {
      const organizationId = await seedOrganization(tx);

      expect(await hasRenewingHostedSubscription(tx, organizationId)).toBe(
        false,
      );
    });
  });

  test("another organization's subscription does not refuse deletion", async () => {
    await withRolledBackTx(async (tx) => {
      const organizationId = await seedOrganization(tx);
      const otherOrganizationId = await seedOrganization(tx);
      await seedEntitlement({
        tx,
        organizationId: otherOrganizationId,
        status: "active",
        source: "hosted",
        cancelAtPeriodEnd: false,
      });

      expect(await hasRenewingHostedSubscription(tx, organizationId)).toBe(
        false,
      );
    });
  });
});
