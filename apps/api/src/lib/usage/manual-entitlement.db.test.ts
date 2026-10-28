import { Result } from "better-result";
import { afterAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import {
  auditLogs,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  usageEntitlements,
  usagePolicies,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  endManualEntitlement,
  grantManualEntitlement,
  ManualEntitlementRefusedError,
} from "@/api/lib/usage/manual-entitlement";
import {
  FREE_TIER_OFF,
  resolveOrganizationAccess,
} from "@/api/lib/usage/organization-access";
import { readOrganizationAccessSnapshot } from "@/api/lib/usage/organization-access-snapshot";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let db: TestDatabase;
const testState = createTestState({ file: import.meta.path, config: env });
const policyIds: SafeId<"usagePolicy">[] = [];
const organizationIds: SafeId<"organization">[] = [];

testState.beforeAll(async () => {
  db = await getTestDb();
  testState.setConfig("FEATURE_CONFIGURED_ACCESS", true);
});

afterAll(async () => {
  for (const organizationId of organizationIds) {
    await db.delete(organization).where(eq(organization.id, organizationId));
  }
  for (const policyId of policyIds) {
    await db.delete(usagePolicies).where(eq(usagePolicies.id, policyId));
  }
  await releaseTestDb();
});

const insertOrganization = async (
  state: "self_managed_keys" | "evaluation_period" = "self_managed_keys",
) => {
  const organizationId = mintAuthProviderId<"organization">();
  organizationIds.push(organizationId);
  await db.insert(organization).values({
    id: organizationId,
    name: "Manual entitlement fixture",
    slug: `manual-${organizationId}`,
    createdAt: new Date(),
  });
  await db.insert(organizationAccessStates).values(
    state === "self_managed_keys"
      ? { organizationId, state: ORGANIZATION_ACCESS_STATE.selfManagedKeys }
      : {
          organizationId,
          state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
          evaluationStartedAt: new Date("2026-01-01T00:00:00.000Z"),
          evaluationEndsAt: new Date("2099-01-01T00:00:00.000Z"),
        },
  );
  return organizationId;
};

const insertPolicy = async ({
  kind = "subscription",
  maxMembers = 10,
  serviceActionsPerPeriod = 73,
}: {
  kind?: "subscription" | "addon";
  maxMembers?: number | null;
  serviceActionsPerPeriod?: number | null;
} = {}) => {
  const id = createSafeId<"usagePolicy">();
  policyIds.push(id);
  await db.insert(usagePolicies).values({
    id,
    policyKey: `manual_${Bun.randomUUIDv7()}`,
    displayName: "Manual entitlement fixture",
    kind,
    monthlyUsageUnits: 100,
    serviceActionsPerPeriod,
    priceBasis: "per_seat",
    maxMembers,
  });
  return id;
};

const grant = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
  usagePolicyId: SafeId<"usagePolicy">,
  seats = 3,
) =>
  await grantManualEntitlement(tx, {
    organizationId,
    usagePolicyId,
    seats,
    periodEndsAt: new Date("2099-01-01T00:00:00.000Z"),
    actor: "operator:test",
    reason: "Database acceptance test",
  });

describe("manual entitlements", () => {
  test("grant resolves paid with the policy budget; end is ending and then lapses", async () => {
    const organizationId = await insertOrganization();
    const usagePolicyId = await insertPolicy();
    await db.transaction(async (testTx) => {
      const tx = asTestRaw<Transaction>(testTx);
      const granted = await grant(tx, organizationId, usagePolicyId);
      expect(Result.isOk(granted)).toBe(true);

      const snapshot = await readOrganizationAccessSnapshot(tx, organizationId);
      expect(
        resolveOrganizationAccess({
          snapshot,
          now: new Date("2030-01-01T00:00:00.000Z"),
          freeTier: FREE_TIER_OFF,
        }),
      ).toEqual({
        type: "paid",
        deadline: new Date("2099-01-01T00:00:00.000Z"),
        serviceActionsPerPeriod: 73,
      });

      const endsAt = new Date("2031-01-01T00:00:00.000Z");
      const ended = await endManualEntitlement(tx, {
        organizationId,
        endsAt,
        actor: "operator:test",
        reason: "Database acceptance test end",
      });
      expect(Result.isOk(ended)).toBe(true);
      const endingSnapshot = await readOrganizationAccessSnapshot(
        tx,
        organizationId,
      );
      expect(
        endingSnapshot?.state === "configured_access" &&
          endingSnapshot.configuredAccess.status,
      ).toBe("ending");
      expect(
        resolveOrganizationAccess({
          snapshot: endingSnapshot,
          now: new Date("2032-01-01T00:00:00.000Z"),
          freeTier: { status: "on", policy: { serviceActionsPerPeriod: 1 } },
        }),
      ).toEqual({ type: "self_managed_keys" });

      const audits = await tx
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.organizationId, organizationId));
      expect(audits).toHaveLength(2);
    });
  });

  test("refuses live hosted and manual entitlements and refuses ending hosted access", async () => {
    const organizationId = await insertOrganization();
    const usagePolicyId = await insertPolicy();
    await db.insert(usageEntitlements).values({
      id: createSafeId<"usageEntitlement">(),
      organizationId,
      usagePolicyId,
      status: "active",
      seats: 1,
      currentPeriodStart: new Date("2026-01-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2099-01-01T00:00:00.000Z"),
      source: "hosted",
      hostedEntitlementExternalId: `hosted_${Bun.randomUUIDv7()}`,
    });
    await db.transaction(async (testTx) => {
      const tx = asTestRaw<Transaction>(testTx);
      const refused = await grant(tx, organizationId, usagePolicyId);
      expect(Result.isError(refused) && refused.error).toBeInstanceOf(
        ManualEntitlementRefusedError,
      );
      const ended = await endManualEntitlement(tx, {
        organizationId,
        endsAt: new Date("2030-01-01T00:00:00.000Z"),
        actor: "operator:test",
        reason: "Must refuse hosted",
      });
      expect(Result.isError(ended)).toBe(true);
    });

    const manualOrganizationId = await insertOrganization();
    const first = await db.transaction(
      async (testTx) =>
        await grant(
          asTestRaw<Transaction>(testTx),
          manualOrganizationId,
          usagePolicyId,
        ),
    );
    expect(Result.isOk(first)).toBe(true);
    const renewed = await db.transaction(
      async (testTx) =>
        await grant(
          asTestRaw<Transaction>(testTx),
          manualOrganizationId,
          usagePolicyId,
          5,
        ),
    );
    expect(Result.isOk(renewed) && renewed.value.seats).toBe(5);
    const rows = await db
      .select({ id: usageEntitlements.id })
      .from(usageEntitlements)
      .where(eq(usageEntitlements.organizationId, manualOrganizationId));
    expect(rows).toHaveLength(1);
  });

  test("refuses a grant over an expired hosted entitlement", async () => {
    const organizationId = await insertOrganization();
    const usagePolicyId = await insertPolicy();
    await db.insert(usageEntitlements).values({
      id: createSafeId<"usageEntitlement">(),
      organizationId,
      usagePolicyId,
      status: "cancelled",
      seats: 1,
      currentPeriodStart: new Date("2020-01-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2021-01-01T00:00:00.000Z"),
      source: "hosted",
      hostedEntitlementExternalId: `hosted_${Bun.randomUUIDv7()}`,
    });
    const result = await db.transaction(
      async (testTx) =>
        await grant(
          asTestRaw<Transaction>(testTx),
          organizationId,
          usagePolicyId,
        ),
    );
    expect(Result.isError(result) && result.error).toBeInstanceOf(
      ManualEntitlementRefusedError,
    );
  });

  test("refuses policies without paid terms and a period already over", async () => {
    const organizationId = await insertOrganization();
    const addonPolicyId = await insertPolicy({ kind: "addon" });
    const unbudgetedPolicyId = await insertPolicy({
      serviceActionsPerPeriod: null,
    });
    const usagePolicyId = await insertPolicy();
    await db.transaction(async (testTx) => {
      const tx = asTestRaw<Transaction>(testTx);
      for (const policyId of [addonPolicyId, unbudgetedPolicyId]) {
        const result = await grant(tx, organizationId, policyId);
        expect(Result.isError(result)).toBe(true);
      }
      const past = await grantManualEntitlement(tx, {
        organizationId,
        usagePolicyId,
        seats: 3,
        periodEndsAt: new Date("2020-01-01T00:00:00.000Z"),
        actor: "operator:test",
        reason: "Database acceptance test",
      });
      expect(Result.isError(past)).toBe(true);
    });
  });

  test("an end time already in the past ends the plan now, never backdated", async () => {
    const organizationId = await insertOrganization();
    const usagePolicyId = await insertPolicy();
    await db.transaction(async (testTx) => {
      const tx = asTestRaw<Transaction>(testTx);
      expect(Result.isOk(await grant(tx, organizationId, usagePolicyId))).toBe(
        true,
      );
      const before = Date.now();
      // A period that began two minutes ago, so ending now is a valid end.
      await tx
        .update(usageEntitlements)
        .set({ currentPeriodStart: new Date(before - 120_000) })
        .where(eq(usageEntitlements.organizationId, organizationId));
      const ended = await endManualEntitlement(tx, {
        organizationId,
        endsAt: new Date(before - 60_000),
        actor: "operator:test",
        reason: "End immediately",
      });
      expect(Result.isOk(ended)).toBe(true);
      if (Result.isOk(ended)) {
        expect(ended.value.currentPeriodEnd.getTime()).toBeGreaterThanOrEqual(
          before,
        );
      }
    });
  });

  test("ending never extends a period or revives a lapsed one", async () => {
    const organizationId = await insertOrganization();
    const usagePolicyId = await insertPolicy();
    await db.transaction(async (testTx) => {
      const tx = asTestRaw<Transaction>(testTx);
      expect(Result.isOk(await grant(tx, organizationId, usagePolicyId))).toBe(
        true,
      );
      const extended = await endManualEntitlement(tx, {
        organizationId,
        endsAt: new Date("2100-01-01T00:00:00.000Z"),
        actor: "operator:test",
        reason: "Must refuse an extension",
      });
      expect(Result.isError(extended)).toBe(true);
    });

    const lapsedOrganizationId = await insertOrganization();
    await db.insert(usageEntitlements).values({
      id: createSafeId<"usageEntitlement">(),
      organizationId: lapsedOrganizationId,
      usagePolicyId,
      status: "active",
      seats: 1,
      currentPeriodStart: new Date("2020-01-01T00:00:00.000Z"),
      currentPeriodEnd: new Date("2021-01-01T00:00:00.000Z"),
      source: "manual",
    });
    const revived = await db.transaction(
      async (testTx) =>
        await endManualEntitlement(asTestRaw<Transaction>(testTx), {
          organizationId: lapsedOrganizationId,
          endsAt: new Date("2030-01-01T00:00:00.000Z"),
          actor: "operator:test",
          reason: "Must refuse a revival",
        }),
    );
    expect(Result.isError(revived)).toBe(true);
    // A lapsed manual entitlement binds no limits any more.
    const effective = await db
      .select({
        kind: sql<
          string | null
        >`(select policy_kind from organization_effective_policy(${lapsedOrganizationId}))`,
      })
      .from(organization)
      .where(eq(organization.id, lapsedOrganizationId));
    expect(effective.at(0)?.kind ?? null).toBeNull();
  });

  test("refuses a grant whose seats are below current members", async () => {
    const organizationId = await insertOrganization("evaluation_period");
    const usagePolicyId = await insertPolicy();
    for (let index = 0; index < 2; index += 1) {
      const userId = mintAuthProviderId<"user">();
      await db.insert(user).values({
        id: userId,
        name: "Capacity member",
        email: `${userId}@manual.test`,
      });
      await db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      });
    }
    const result = await db.transaction(
      async (testTx) =>
        await grant(
          asTestRaw<Transaction>(testTx),
          organizationId,
          usagePolicyId,
          1,
        ),
    );
    expect(Result.isError(result)).toBe(true);
  });
});
