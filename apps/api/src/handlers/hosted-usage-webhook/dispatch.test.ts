import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, TransactionRollbackError } from "drizzle-orm";

import type { Transaction } from "@/api/db";
import { organization, user } from "@/api/db/auth-schema";
import { usageEntitlements, usagePolicies } from "@/api/db/schema";
import {
  handleHostedAllocation,
  handleUsageEntitlementStatusChange,
  handleHostedEntitlementUpsert,
} from "@/api/handlers/hosted-usage-webhook/dispatch";
import type {
  HostedUsageAllocationPayload,
  HostedUsageEntitlementPayload,
} from "@/api/handlers/hosted-usage-webhook/event-schemas";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { getRemainingUsageUnits } from "@/api/lib/usage";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

const PERIOD_START = new Date("2026-07-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-08-01T00:00:00.000Z");
const NEXT_PERIOD_START = PERIOD_END;
const NEXT_PERIOD_END = new Date("2026-09-01T00:00:00.000Z");

type Fixture = {
  organizationId: SafeId<"organization">;
  usagePolicyId: SafeId<"usagePolicy">;
  hostedPolicyRef: string;
  hostedAccountRef: string;
  hostedEntitlementExternalId: string;
};

const setupFixture = async (tx: Transaction): Promise<Fixture> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = `user_${Bun.randomUUIDv7()}`;
  const hostedPolicyRef = `provider_policy_${Bun.randomUUIDv7()}`;

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

  const inserted = await tx
    .insert(usagePolicies)
    .values({
      policyKey: "hosted-test",
      displayName: "Pro",
      monthlyUsageUnits: 1000,
      hostedPolicyRef,
    })
    .returning({ id: usagePolicies.id });
  const usagePolicyId = inserted.at(0)?.id;
  if (!usagePolicyId) {
    throw new Error("Failed to insert test plan");
  }

  return {
    organizationId,
    usagePolicyId,
    hostedPolicyRef,
    hostedAccountRef: `provider_account_${Bun.randomUUIDv7()}`,
    hostedEntitlementExternalId: `provider_ent_${Bun.randomUUIDv7()}`,
  };
};

const withRolledBackTx = async (
  fn: (tx: Transaction) => Promise<void>,
): Promise<void> => {
  try {
    await testDb.transaction(async (rawTx) => {
      // SAFETY: PGlite drizzle transaction is structurally compatible
      // with prod BunSQL transaction for the queries we run here.
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

const buildEntitlementPayload = (
  fx: Fixture,
  overrides: Partial<HostedUsageEntitlementPayload> = {},
): HostedUsageEntitlementPayload => ({
  id: fx.hostedEntitlementExternalId,
  status: "active",
  account_ref: fx.hostedAccountRef,
  policy_ref: fx.hostedPolicyRef,
  current_period_start: PERIOD_START.toISOString(),
  current_period_end: PERIOD_END.toISOString(),
  quantity: 3,
  metadata: { organization_id: fx.organizationId },
  ...overrides,
});

const buildAllocationPayload = (
  fx: Fixture,
  overrides: Partial<HostedUsageAllocationPayload> = {},
): HostedUsageAllocationPayload => ({
  id: `provider_ord_${Bun.randomUUIDv7()}`,
  account_ref: fx.hostedAccountRef,
  policy_ref: fx.hostedPolicyRef,
  allocation_reason: "addon",
  metadata: { organization_id: fx.organizationId },
  ...overrides,
});

describe("dispatch — handleHostedEntitlementUpsert", () => {
  test("creates entitlement and allocates policy units by seat count on a fresh event", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const outcome = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_001",
      });
      expect(outcome.kind).toBe("applied");

      const entitlementRows = await tx
        .select({
          status: usageEntitlements.status,
          seats: usageEntitlements.seats,
          source: usageEntitlements.source,
          hostedEntitlementExternalId:
            usageEntitlements.hostedEntitlementExternalId,
        })
        .from(usageEntitlements)
        .where(eq(usageEntitlements.organizationId, fx.organizationId));
      expect(entitlementRows).toHaveLength(1);
      expect(entitlementRows.at(0)?.source).toBe("hosted");
      expect(entitlementRows.at(0)?.seats).toBe(3);

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });
      // 1000 units per seat x 3 seats = 3000
      expect(balance).toBe(3000);
    });
  });

  test("ignores event without metadata.organization_id", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const outcome = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, { metadata: undefined }),
        eventId: "evt_create_002",
      });
      expect(outcome.kind).toBe("ignored");
      if (outcome.kind === "ignored") {
        expect(outcome.reason).toContain("organization_id");
      }
    });
  });

  test("ignores event when policy reference is not mapped to a usage policy", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const outcome = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          policy_ref: "provider_policy_unknown",
        }),
        eventId: "evt_create_003",
      });
      expect(outcome.kind).toBe("ignored");
      if (outcome.kind === "ignored") {
        expect(outcome.reason).toContain("hosted policy reference");
      }
    });
  });

  test("refuses to overwrite a manually-managed entitlement", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await tx.insert(usageEntitlements).values({
        organizationId: fx.organizationId,
        usagePolicyId: fx.usagePolicyId,
        status: "active",
        seats: 1,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        hostedAccountRef: fx.hostedAccountRef,
        source: "manual",
      });
      const outcome = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_004",
      });
      expect(outcome.kind).toBe("ignored");
      if (outcome.kind === "ignored") {
        expect(outcome.reason).toContain("manual");
      }
    });
  });

  test("refuses to update when metadata org_id mismatches the local mapping", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      // First create the entitlement cleanly so a local mapping exists.
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_mismatch_seed",
      });
      // Now replay an update with metadata pointing at a DIFFERENT org.
      const fakeOtherOrgId = toSafeId<"organization">(
        `org_${Bun.randomUUIDv7()}`,
      );
      const outcome = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          metadata: { organization_id: fakeOtherOrgId },
        }),
        eventId: "evt_create_mismatch",
      });
      expect(outcome.kind).toBe("ignored");
      if (outcome.kind === "ignored") {
        expect(outcome.reason).toContain("mismatch");
      }
      // The original org's balance must NOT be touched.
      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });
      expect(balance).toBe(3000);
    });
  });

  test("different event ids in the same period do not double-allocate", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const payload = buildEntitlementPayload(fx);
      // Providers may emit many updates per period (status flips, seat
      // changes). Each carries a fresh event id. The periodic allocation
      // must be idempotent on (provider entitlement id, period_start), NOT on
      // event id — otherwise every update mints another allocation.
      await handleHostedEntitlementUpsert({
        tx,
        payload,
        eventId: "evt_period_a",
      });
      await handleHostedEntitlementUpsert({
        tx,
        payload,
        eventId: "evt_period_b",
      });
      await handleHostedEntitlementUpsert({
        tx,
        payload,
        eventId: "evt_period_c",
      });
      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });
      // Still one allocation: 1000 × 3 = 3000
      expect(balance).toBe(3000);
    });
  });

  test("fresh period update creates a new periodic allocation", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_period_boundary_a",
      });
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_period_boundary_b",
      });

      const firstPeriodBalance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });
      expect(firstPeriodBalance).toBe(3000);

      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          current_period_start: NEXT_PERIOD_START.toISOString(),
          current_period_end: NEXT_PERIOD_END.toISOString(),
        }),
        eventId: "evt_period_boundary_c",
      });

      const nextPeriodBalance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(NEXT_PERIOD_START.getTime() + 1000),
      });
      expect(nextPeriodBalance).toBe(3000);
    });
  });

  test("idempotent on duplicate event id — replay does not double-allocate", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const payload = buildEntitlementPayload(fx);
      const first = await handleHostedEntitlementUpsert({
        tx,
        payload,
        eventId: "evt_dup_001",
      });
      const second = await handleHostedEntitlementUpsert({
        tx,
        payload,
        eventId: "evt_dup_001",
      });
      expect(first.kind).toBe("applied");
      expect(second.kind).toBe("applied");

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });
      // Still one allocation: 1000 × 3 = 3000
      expect(balance).toBe(3000);
    });
  });
});

describe("dispatch — handleUsageEntitlementStatusChange", () => {
  test("canceled event keeps status active and flips cancel_at_period_end", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_status_001",
      });
      const outcome = await handleUsageEntitlementStatusChange({
        tx,
        payload: buildEntitlementPayload(fx, { status: "active" }),
        eventId: "evt_status_cancel_001",
        eventKind: "canceled",
      });
      expect(outcome.kind).toBe("applied");

      const entitlementRows = await tx
        .select({
          status: usageEntitlements.status,
          cancelAtPeriodEnd: usageEntitlements.cancelAtPeriodEnd,
        })
        .from(usageEntitlements)
        .where(eq(usageEntitlements.organizationId, fx.organizationId));
      expect(entitlementRows.at(0)?.status).toBe("active");
      expect(entitlementRows.at(0)?.cancelAtPeriodEnd).toBe(true);
    });
  });

  test("revoked event flips status to cancelled and clears cancel_at_period_end", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_status_002",
      });
      const outcome = await handleUsageEntitlementStatusChange({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_status_revoke_001",
        eventKind: "revoked",
      });
      expect(outcome.kind).toBe("applied");

      const entitlementRows = await tx
        .select({
          status: usageEntitlements.status,
          cancelAtPeriodEnd: usageEntitlements.cancelAtPeriodEnd,
        })
        .from(usageEntitlements)
        .where(eq(usageEntitlements.organizationId, fx.organizationId));
      expect(entitlementRows.at(0)?.status).toBe("cancelled");
      expect(entitlementRows.at(0)?.cancelAtPeriodEnd).toBe(false);
    });
  });

  test("ignored when no matching entitlement exists", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const outcome = await handleUsageEntitlementStatusChange({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_status_orphan_001",
        eventKind: "revoked",
      });
      expect(outcome.kind).toBe("ignored");
    });
  });
});

describe("dispatch — handleHostedAllocation", () => {
  test("allocates add-on units to the current period", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_addon_001",
      });
      const balanceBefore = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });

      const outcome = await handleHostedAllocation({
        tx,
        payload: buildAllocationPayload(fx),
        eventId: "evt_allocation_001",
      });
      expect(outcome.kind).toBe("applied");

      const balanceAfter = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });
      // Add-on allocates the plan's monthlyUsageUnits (1000) to the period.
      expect(balanceAfter - balanceBefore).toBe(1000);
    });
  });

  test("idempotent on duplicate event id", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_addon_002",
      });
      const payload = buildAllocationPayload(fx);
      const first = await handleHostedAllocation({
        tx,
        payload,
        eventId: "evt_allocation_dup",
      });
      const second = await handleHostedAllocation({
        tx,
        payload,
        eventId: "evt_allocation_dup",
      });
      expect(first.kind).toBe("applied");
      expect(second.kind).toBe("duplicate_allocation");
    });
  });

  test("ignored for entitlement-cycle allocations", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_addon_cycle_seed",
      });
      const balanceBefore = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });

      const outcome = await handleHostedAllocation({
        tx,
        payload: buildAllocationPayload(fx, {
          allocation_reason: "entitlement_cycle",
        }),
        eventId: "evt_allocation_entitlement_cycle",
      });
      expect(outcome.kind).toBe("ignored");
      if (outcome.kind === "ignored") {
        expect(outcome.reason).toContain("allocation_reason");
      }

      const balanceAfter = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });
      expect(balanceAfter).toBe(balanceBefore);
    });
  });

  test("ignored when org has no entitlement to attribute the add-on to", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const outcome = await handleHostedAllocation({
        tx,
        payload: buildAllocationPayload(fx),
        eventId: "evt_allocation_orphan",
      });
      expect(outcome.kind).toBe("ignored");
      if (outcome.kind === "ignored") {
        expect(outcome.reason).toContain("no associated entitlement");
      }
    });
  });

  test("ignored when metadata org_id mismatches local entitlement mapping", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_addon_mismatch_seed",
      });
      const fakeOtherOrgId = toSafeId<"organization">(
        `org_${Bun.randomUUIDv7()}`,
      );
      const outcome = await handleHostedAllocation({
        tx,
        payload: buildAllocationPayload(fx, {
          metadata: { organization_id: fakeOtherOrgId },
        }),
        eventId: "evt_allocation_mismatch",
      });
      expect(outcome.kind).toBe("ignored");
      if (outcome.kind === "ignored") {
        expect(outcome.reason).toContain("mismatch");
      }
    });
  });

  test("ignored when metadata.organization_id is missing", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_create_addon_003",
      });
      const outcome = await handleHostedAllocation({
        tx,
        payload: buildAllocationPayload(fx, { metadata: undefined }),
        eventId: "evt_allocation_no_meta",
      });
      expect(outcome.kind).toBe("ignored");
      if (outcome.kind === "ignored") {
        expect(outcome.reason).toContain("organization_id");
      }
    });
  });
});
