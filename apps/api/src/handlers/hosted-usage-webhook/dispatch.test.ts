import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, TransactionRollbackError } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import {
  handleHostedAllocation,
  handleUsageEntitlementStatusChange,
  handleHostedEntitlementUpsert,
} from "@/api/handlers/hosted-usage-webhook/dispatch";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type {
  HostedUsageAllocationPayload,
  HostedUsageEntitlementPayload,
} from "@/api/lib/hosted-usage-provider/event-schemas";
import { getRemainingUsageUnits } from "@/api/lib/usage/usage-ledger";
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

const PERIOD_START = new Date("2026-07-01T00:00:00.000Z");
const PERIOD_END = new Date("2026-08-01T00:00:00.000Z");
const NEXT_PERIOD_START = PERIOD_END;
const NEXT_PERIOD_END = new Date("2026-09-01T00:00:00.000Z");

type Fixture = {
  organizationId: SafeId<"organization">;
  /** A member of the fixture organization: a valid seat_user_id. */
  memberUserId: string;
  usagePolicyId: SafeId<"usagePolicy">;
  hostedPolicyRef: string;
  hostedAddonPolicyRef: string;
  hostedAccountRef: string;
  hostedEntitlementExternalId: string;
};

const setupFixture = async (tx: Transaction): Promise<Fixture> => {
  const organizationId = toSafeId<"organization">(`org_${Bun.randomUUIDv7()}`);
  const userId = `user_${Bun.randomUUIDv7()}`;
  const hostedPolicyRef = `provider_policy_${Bun.randomUUIDv7()}`;
  const hostedAddonPolicyRef = `provider_addon_${Bun.randomUUIDv7()}`;

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
  await tx.insert(member).values({
    id: `member_${Bun.randomUUIDv7()}`,
    organizationId,
    userId,
    role: "owner",
    createdAt: PERIOD_START,
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

  await tx.insert(usagePolicies).values({
    policyKey: "hosted-addon-test",
    displayName: "Extra units",
    kind: "addon",
    monthlyUsageUnits: 1000,
    hostedPolicyRef: hostedAddonPolicyRef,
  });

  return {
    organizationId,
    memberUserId: userId,
    usagePolicyId,
    hostedPolicyRef,
    hostedAddonPolicyRef,
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
  policy_ref: fx.hostedAddonPolicyRef,
  allocation_reason: "addon",
  metadata: { organization_id: fx.organizationId },
  ...overrides,
});

const readSeatAssignments = async (tx: Transaction, fx: Fixture) =>
  await tx
    .select({ userId: usageSeatAssignments.userId })
    .from(usageSeatAssignments)
    .where(eq(usageSeatAssignments.organizationId, fx.organizationId));

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

  test("ignores a fresh event without metadata.organization_id", async () => {
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

  test("applies a mapped entitlement update that arrives without metadata", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      // Seed a clean hosted entitlement so a local mapping exists.
      const seed = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_no_meta_seed",
      });
      expect(seed.kind).toBe("applied");

      // A renewal for the next period arrives WITHOUT metadata. The local
      // row owns the org id, so it must still apply: advance the period and
      // create the next period's allocation rather than drop the event.
      const renewal = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          metadata: undefined,
          current_period_start: NEXT_PERIOD_START.toISOString(),
          current_period_end: NEXT_PERIOD_END.toISOString(),
        }),
        eventId: "evt_no_meta_renewal",
      });
      expect(renewal.kind).toBe("applied");

      const entitlementRows = await tx
        .select({ id: usageEntitlements.id })
        .from(usageEntitlements)
        .where(eq(usageEntitlements.organizationId, fx.organizationId));
      expect(entitlementRows).toHaveLength(1);

      const nextPeriodBalance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(NEXT_PERIOD_START.getTime() + 1000),
      });
      expect(nextPeriodBalance).toBe(3000);
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

  test("refuses to create an entitlement from an add-on policy", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const outcome = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          policy_ref: fx.hostedAddonPolicyRef,
        }),
        eventId: "evt_wrong_policy_kind_subscription",
      });

      expect(outcome).toEqual({
        kind: "ignored",
        reason: `no subscription usage_policy matches hosted policy reference ${fx.hostedAddonPolicyRef}`,
      });
      const rows = await tx
        .select({ id: usageEntitlements.id })
        .from(usageEntitlements)
        .where(eq(usageEntitlements.organizationId, fx.organizationId));
      expect(rows).toHaveLength(0);
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

  test("updates hosted entitlement matched by account reference when external id changes", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const first = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_external_ref_seed",
      });
      expect(first.kind).toBe("applied");

      const nextExternalId = `provider_ent_${Bun.randomUUIDv7()}`;
      const second = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          id: nextExternalId,
          quantity: 5,
          status: "trialing",
        }),
        eventId: "evt_external_ref_change",
      });
      expect(second.kind).toBe("applied");

      const entitlementRows = await tx
        .select({
          id: usageEntitlements.id,
          hostedEntitlementExternalId:
            usageEntitlements.hostedEntitlementExternalId,
          seats: usageEntitlements.seats,
          status: usageEntitlements.status,
        })
        .from(usageEntitlements)
        .where(eq(usageEntitlements.organizationId, fx.organizationId));
      expect(entitlementRows).toHaveLength(1);
      expect(entitlementRows.at(0)?.hostedEntitlementExternalId).toBe(
        nextExternalId,
      );
      expect(entitlementRows.at(0)?.seats).toBe(5);
      expect(entitlementRows.at(0)?.status).toBe("trialing");

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });
      // Still one periodic allocation for this local entitlement and period.
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
  test("creates entitlement without allocation for a zero-unit policy", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      // A zero-unit (e.g. BYOK-only) hosted policy. usage_allocations
      // forbids a 0-unit row, so the periodic allocation must be skipped
      // rather than roll back the whole webhook transaction.
      const zeroPolicyRef = `provider_policy_${Bun.randomUUIDv7()}`;
      await tx.insert(usagePolicies).values({
        policyKey: `hosted-zero-${Bun.randomUUIDv7()}`,
        displayName: "BYOK",
        monthlyUsageUnits: 0,
        hostedPolicyRef: zeroPolicyRef,
      });
      const outcome = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, { policy_ref: zeroPolicyRef }),
        eventId: "evt_zero_units",
      });
      expect(outcome.kind).toBe("applied");

      const entitlementRows = await tx
        .select({ id: usageEntitlements.id })
        .from(usageEntitlements)
        .where(eq(usageEntitlements.organizationId, fx.organizationId));
      expect(entitlementRows).toHaveLength(1);

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: new Date(PERIOD_START.getTime() + 1000),
      });
      expect(balance).toBe(0);
    });
  });

  test("a fresh entitlement seats the metadata seat_user_id exactly once", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      const payload = buildEntitlementPayload(fx, {
        metadata: {
          organization_id: fx.organizationId,
          seat_user_id: fx.memberUserId,
        },
      });

      const created = await handleHostedEntitlementUpsert({
        tx,
        payload,
        eventId: "evt_seat_scope_create",
      });
      expect(created.kind).toBe("applied");
      expect(await readSeatAssignments(tx, fx)).toEqual([
        { userId: fx.memberUserId },
      ]);

      // A re-delivery carries the same seat metadata; the purchaser must
      // occupy one seat, not one per webhook delivery.
      const redelivery = await handleHostedEntitlementUpsert({
        tx,
        payload,
        eventId: "evt_seat_scope_redelivery",
      });
      expect(redelivery.kind).toBe("applied");
      expect(await readSeatAssignments(tx, fx)).toEqual([
        { userId: fx.memberUserId },
      ]);
    });
  });

  test("shrinking the quantity trims the roster to the oldest designations", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_shrink_create",
      });

      // Three designated members with distinct designation times; the
      // handler-side default (now()) is the transaction timestamp, so
      // explicit stamps are what make keep-oldest observable.
      const designated = [fx.memberUserId];
      for (const _extra of [1, 2]) {
        const extraUserId = `user_${Bun.randomUUIDv7()}`;
        await tx.insert(user).values({
          id: extraUserId,
          name: "Extra Member",
          email: `${extraUserId}@test.local`,
        });
        await tx.insert(member).values({
          id: `member_${Bun.randomUUIDv7()}`,
          organizationId: fx.organizationId,
          userId: extraUserId,
          role: "member",
          createdAt: PERIOD_START,
        });
        designated.push(extraUserId);
      }
      await tx.insert(usageSeatAssignments).values(
        designated.map((userId, index) => ({
          organizationId: fx.organizationId,
          userId,
          createdAt: new Date(PERIOD_START.getTime() + index * 3_600_000),
        })),
      );

      const outcome = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, { quantity: 1 }),
        eventId: "evt_shrink_update",
      });
      expect(outcome.kind).toBe("applied");
      // Only the earliest designation survives a shrink to one.
      expect(await readSeatAssignments(tx, fx)).toEqual([
        { userId: fx.memberUserId },
      ]);
    });
  });

  test("a seat_user_id outside the organization seats nobody", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      // A real user row that is not a member here: membership, not the
      // foreign key, has to be what rejects the value.
      const outsiderUserId = `user_${Bun.randomUUIDv7()}`;
      await tx.insert(user).values({
        id: outsiderUserId,
        name: "Outsider",
        email: `${outsiderUserId}@test.local`,
      });

      const outcome = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          metadata: {
            organization_id: fx.organizationId,
            seat_user_id: outsiderUserId,
          },
        }),
        eventId: "evt_seat_scope_outsider",
      });
      expect(outcome.kind).toBe("applied");
      expect(await readSeatAssignments(tx, fx)).toEqual([]);
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

  test("refuses an add-on allocation from a subscription policy", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx),
        eventId: "evt_wrong_policy_kind_seed",
      });
      const asOf = new Date(PERIOD_START.getTime() + 1000);
      const balanceBefore = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf,
      });

      const outcome = await handleHostedAllocation({
        tx,
        payload: buildAllocationPayload(fx, {
          policy_ref: fx.hostedPolicyRef,
        }),
        eventId: "evt_wrong_policy_kind_addon",
      });

      expect(outcome).toEqual({
        kind: "ignored",
        reason: `no add-on usage_policy matches hosted policy reference ${fx.hostedPolicyRef}`,
      });
      expect(
        await getRemainingUsageUnits({
          tx,
          organizationId: fx.organizationId,
          asOf,
        }),
      ).toBe(balanceBefore);
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

// Instants sampled at exact fractions of the 31-day fixture period, so the
// pro-rata arithmetic is fixed by the payload rather than by the wall clock.
const HALF_PERIOD_ISO = "2026-07-16T12:00:00.000Z";
const QUARTER_REMAINING_ISO = "2026-07-24T06:00:00.000Z";
const NEXT_PERIOD_HALF_ISO = "2026-08-16T12:00:00.000Z";
const IN_PERIOD_ASOF = new Date(PERIOD_START.getTime() + 1000);
const IN_NEXT_PERIOD_ASOF = new Date(NEXT_PERIOD_START.getTime() + 1000);

const readSeatState = async (tx: Transaction, fx: Fixture) => {
  const rows = await tx
    .select({
      seats: usageEntitlements.seats,
      hostedPeakSeats: usageEntitlements.hostedPeakSeats,
    })
    .from(usageEntitlements)
    .where(eq(usageEntitlements.organizationId, fx.organizationId));
  return rows.at(0);
};

/** Fresh hosted entitlement at 3 seats: 1000 × 3 = 3000 periodic units. */
const seedThreeSeats = async (tx: Transaction, fx: Fixture): Promise<void> => {
  const created = await handleHostedEntitlementUpsert({
    tx,
    payload: buildEntitlementPayload(fx, {
      occurred_at: PERIOD_START.toISOString(),
    }),
    eventId: "evt_seats_seed_create",
  });
  expect(created.kind).toBe("applied");
};

/** Seed, then raise to 5 seats at the period's midpoint (+1000 units). */
const seedIncreaseToFive = async (
  tx: Transaction,
  fx: Fixture,
): Promise<void> => {
  await seedThreeSeats(tx, fx);
  const increased = await handleHostedEntitlementUpsert({
    tx,
    payload: buildEntitlementPayload(fx, {
      quantity: 5,
      occurred_at: HALF_PERIOD_ISO,
    }),
    eventId: "evt_seats_seed_increase",
  });
  expect(increased.kind).toBe("applied");
};

describe("dispatch — mid-period seat proration", () => {
  test("seat increase grants units for the added seats, pro-rated by the remaining period", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedIncreaseToFive(tx, fx);

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: IN_PERIOD_ASOF,
      });
      // 1000 × 3 periodic + floor(1000 × 2 added seats × 0.5 remaining)
      expect(balance).toBe(4000);

      const row = await readSeatState(tx, fx);
      expect(row?.seats).toBe(5);
      expect(row?.hostedPeakSeats).toBe(5);
    });
  });

  test("a re-delivered seat increase does not grant the delta twice", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedIncreaseToFive(tx, fx);

      // Same seat count, later timestamp, fresh event id. The added seats
      // are granted once per period, not once per delivery — otherwise a
      // provider retry would mint units at its own remaining fraction.
      const redelivery = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          quantity: 5,
          occurred_at: QUARTER_REMAINING_ISO,
        }),
        eventId: "evt_seats_increase_redelivered",
      });
      expect(redelivery.kind).toBe("applied");

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: IN_PERIOD_ASOF,
      });
      expect(balance).toBe(4000);
    });
  });

  test("seat decrease grants nothing and claws nothing back", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedIncreaseToFive(tx, fx);

      const decreased = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          quantity: 2,
          occurred_at: "2026-07-17T00:00:00.000Z",
        }),
        eventId: "evt_seats_decrease",
      });
      expect(decreased.kind).toBe("applied");

      const balance = await getRemainingUsageUnits({
        tx,
        organizationId: fx.organizationId,
        asOf: IN_PERIOD_ASOF,
      });
      expect(balance).toBe(4000);

      const row = await readSeatState(tx, fx);
      expect(row?.seats).toBe(2);
      // The peak records capacity already granted this period; it must not
      // follow seats down, or the next increase would re-grant it.
      expect(row?.hostedPeakSeats).toBe(5);
    });
  });

  test("re-increasing up to the period peak grants nothing; only seats above it do", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedIncreaseToFive(tx, fx);
      await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          quantity: 2,
          occurred_at: "2026-07-17T00:00:00.000Z",
        }),
        eventId: "evt_seats_cycle_down",
      });

      // Back up to 4, still under the period's peak of 5: that capacity was
      // already paid out, so cycling seats cannot mint it again.
      const belowPeak = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          quantity: 4,
          occurred_at: "2026-07-18T00:00:00.000Z",
        }),
        eventId: "evt_seats_cycle_up_below_peak",
      });
      expect(belowPeak.kind).toBe("applied");
      expect(
        await getRemainingUsageUnits({
          tx,
          organizationId: fx.organizationId,
          asOf: IN_PERIOD_ASOF,
        }),
      ).toBe(4000);

      const abovePeak = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          quantity: 6,
          occurred_at: QUARTER_REMAINING_ISO,
        }),
        eventId: "evt_seats_cycle_up_above_peak",
      });
      expect(abovePeak.kind).toBe("applied");
      // Only the single seat above the peak counts, with a quarter of the
      // period left: floor(1000 × 1 × 0.25) = 250.
      expect(
        await getRemainingUsageUnits({
          tx,
          organizationId: fx.organizationId,
          asOf: IN_PERIOD_ASOF,
        }),
      ).toBe(4250);

      const row = await readSeatState(tx, fx);
      expect(row?.seats).toBe(6);
      expect(row?.hostedPeakSeats).toBe(6);
    });
  });

  test("period rollover resets the peak to the renewed seat count", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedThreeSeats(tx, fx);

      const renewal = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          quantity: 2,
          current_period_start: NEXT_PERIOD_START.toISOString(),
          current_period_end: NEXT_PERIOD_END.toISOString(),
          occurred_at: NEXT_PERIOD_START.toISOString(),
        }),
        eventId: "evt_seats_renewal",
      });
      expect(renewal.kind).toBe("applied");

      // A new period allocates from scratch at the renewed seat count; the
      // previous period's higher peak must not survive the rollover.
      expect(
        await getRemainingUsageUnits({
          tx,
          organizationId: fx.organizationId,
          asOf: IN_NEXT_PERIOD_ASOF,
        }),
      ).toBe(2000);
      expect((await readSeatState(tx, fx))?.hostedPeakSeats).toBe(2);

      const increase = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          quantity: 3,
          current_period_start: NEXT_PERIOD_START.toISOString(),
          current_period_end: NEXT_PERIOD_END.toISOString(),
          occurred_at: NEXT_PERIOD_HALF_ISO,
        }),
        eventId: "evt_seats_renewal_increase",
      });
      expect(increase.kind).toBe("applied");
      // Measured against the reset peak of 2: floor(1000 × 1 × 0.5) = 500.
      expect(
        await getRemainingUsageUnits({
          tx,
          organizationId: fx.organizationId,
          asOf: IN_NEXT_PERIOD_ASOF,
        }),
      ).toBe(2500);
      expect((await readSeatState(tx, fx))?.hostedPeakSeats).toBe(3);
    });
  });

  test("a row with no recorded peak measures the delta against its seat count", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);
      await seedThreeSeats(tx, fx);
      // Rows written before the peak column existed carry null. Those seats
      // were granted by the period's periodic allocation, so the null must
      // read as the row's seat count, never as zero.
      await tx
        .update(usageEntitlements)
        .set({ hostedPeakSeats: null })
        .where(eq(usageEntitlements.organizationId, fx.organizationId));

      const increase = await handleHostedEntitlementUpsert({
        tx,
        payload: buildEntitlementPayload(fx, {
          quantity: 5,
          occurred_at: HALF_PERIOD_ISO,
        }),
        eventId: "evt_seats_legacy_null_peak",
      });
      expect(increase.kind).toBe("applied");

      // floor(1000 × (5 − 3) × 0.5) = 1000 on top of the 3000 periodic units.
      expect(
        await getRemainingUsageUnits({
          tx,
          organizationId: fx.organizationId,
          asOf: IN_PERIOD_ASOF,
        }),
      ).toBe(4000);
      expect((await readSeatState(tx, fx))?.hostedPeakSeats).toBe(5);
    });
  });
});

describe("dispatch — out-of-order provider events", () => {
  test("a stale retry cannot resurrect a newer revocation", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);

      const first = await handleHostedEntitlementUpsert({
        tx,
        eventId: "evt_active_t1",
        payload: buildEntitlementPayload(fx, {
          occurred_at: "2026-07-01T10:00:00.000Z",
        }),
      });
      expect(first.kind).toBe("applied");

      const revoked = await handleUsageEntitlementStatusChange({
        tx,
        eventId: "evt_revoked_t3",
        eventKind: "revoked",
        payload: buildEntitlementPayload(fx, {
          occurred_at: "2026-07-03T10:00:00.000Z",
        }),
      });
      expect(revoked.kind).toBe("applied");

      const stale = await handleHostedEntitlementUpsert({
        tx,
        eventId: "evt_update_t2_retry",
        payload: buildEntitlementPayload(fx, {
          occurred_at: "2026-07-02T10:00:00.000Z",
        }),
      });
      expect(stale.kind).toBe("ignored");

      const rows = await tx
        .select({ status: usageEntitlements.status })
        .from(usageEntitlements)
        .where(eq(usageEntitlements.organizationId, fx.organizationId));
      expect(rows.at(0)?.status).toBe("cancelled");
    });
  });

  test("a stale revocation retry does not regress a newer state", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);

      const first = await handleHostedEntitlementUpsert({
        tx,
        eventId: "evt_active_t2",
        payload: buildEntitlementPayload(fx, {
          occurred_at: "2026-07-02T10:00:00.000Z",
        }),
      });
      expect(first.kind).toBe("applied");

      const staleRevoke = await handleUsageEntitlementStatusChange({
        tx,
        eventId: "evt_revoked_t1_retry",
        eventKind: "revoked",
        payload: buildEntitlementPayload(fx, {
          occurred_at: "2026-07-01T10:00:00.000Z",
        }),
      });
      expect(staleRevoke.kind).toBe("ignored");

      const rows = await tx
        .select({ status: usageEntitlements.status })
        .from(usageEntitlements)
        .where(eq(usageEntitlements.organizationId, fx.organizationId));
      expect(rows.at(0)?.status).toBe("active");
    });
  });

  test("events without timestamps keep delivery-order semantics", async () => {
    await withRolledBackTx(async (tx) => {
      const fx = await setupFixture(tx);

      const first = await handleHostedEntitlementUpsert({
        tx,
        eventId: "evt_no_ts_1",
        payload: buildEntitlementPayload(fx),
      });
      expect(first.kind).toBe("applied");

      const second = await handleUsageEntitlementStatusChange({
        tx,
        eventId: "evt_no_ts_2",
        eventKind: "revoked",
        payload: buildEntitlementPayload(fx),
      });
      expect(second.kind).toBe("applied");
    });
  });
});
