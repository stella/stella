/**
 * The effective-policy owner on the real engine: every access state, every
 * entitlement status of `ENTITLEMENT_LIMIT_DISPOSITION_BY_STATUS`, both
 * scheduled-cancellation flags (which never change the outcome), both period positions and the free floor
 * present or absent, against an oracle derived from that map. The member and
 * storage capacity functions are read for the same matrix, the member insert
 * trigger refuses past a downgraded capacity without removing anyone, and
 * the partial unique index admits one active free policy only. Everything
 * runs in one transaction that is rolled back, so the free floor never
 * leaks into another suite.
 */

import { describe, expect, test } from "bun:test";
import { sql, TransactionRollbackError } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  USAGE_ENTITLEMENT_STATUSES,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
  type UsageEntitlementStatus,
} from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { isRecord } from "@/api/lib/type-guards";
import {
  ENTITLEMENT_LIMIT_DISPOSITION,
  ENTITLEMENT_LIMIT_DISPOSITION_BY_STATUS,
} from "@/api/lib/usage/effective-policy";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const FREE_STORAGE_BYTES = 1_073_741_824n;
const PAID_STORAGE_BYTES_PER_ASSIGNMENT = 5000n;
const PAID_MAX_MEMBERS = 10;
const PAID_SEATS = 3;
const ASSIGNMENTS = 2;

const ACCESS_CASES = [
  "missing",
  "self_managed_keys",
  "evaluation_running",
  "evaluation_lapsed",
  "evaluation_ended",
] as const;
type AccessCase = (typeof ACCESS_CASES)[number];

type EntitlementCase =
  | { type: "none" }
  | {
      type: "entitlement";
      status: UsageEntitlementStatus;
      cancelAtPeriodEnd: "scheduled" | "not_scheduled";
      period: "running" | "ended";
    };

const ENTITLEMENT_CASES: EntitlementCase[] = [{ type: "none" }];
for (const status of USAGE_ENTITLEMENT_STATUSES) {
  for (const cancelAtPeriodEnd of ["scheduled", "not_scheduled"] as const) {
    for (const period of ["running", "ended"] as const) {
      ENTITLEMENT_CASES.push({
        type: "entitlement",
        status,
        cancelAtPeriodEnd,
        period,
      });
    }
  }
}

// The oracle, from the TypeScript map alone.
const entitlementBinds = (entitlement: EntitlementCase): boolean => {
  if (entitlement.type === "none") {
    return false;
  }
  const disposition =
    ENTITLEMENT_LIMIT_DISPOSITION_BY_STATUS[entitlement.status];
  switch (disposition) {
    case ENTITLEMENT_LIMIT_DISPOSITION.paid:
      return true;
    case ENTITLEMENT_LIMIT_DISPOSITION.untilPeriodEnd:
      return entitlement.period === "running";
    default:
      disposition satisfies never;
      throw new Error("unreachable disposition");
  }
};

const FALLS_TO_FREE_BY_ACCESS = {
  missing: false,
  self_managed_keys: false,
  evaluation_running: false,
  evaluation_lapsed: true,
  evaluation_ended: true,
} as const satisfies Record<AccessCase, boolean>;

const BOUNDS_MEMBERS_BY_ACCESS = {
  missing: false,
  self_managed_keys: false,
  evaluation_running: true,
  evaluation_lapsed: true,
  evaluation_ended: true,
} as const satisfies Record<AccessCase, boolean>;

type Expected = {
  kind: "subscription" | "free" | null;
  memberCapacity: number | null;
  storageCapacity: bigint | null;
};

const expected = (
  access: AccessCase,
  entitlement: EntitlementCase,
  freeFloor: "seeded" | "absent",
): Expected => {
  if (entitlementBinds(entitlement)) {
    return {
      kind: "subscription",
      memberCapacity: BOUNDS_MEMBERS_BY_ACCESS[access]
        ? Math.min(PAID_MAX_MEMBERS, PAID_SEATS)
        : null,
      storageCapacity: PAID_STORAGE_BYTES_PER_ASSIGNMENT * BigInt(ASSIGNMENTS),
    };
  }
  if (freeFloor === "seeded" && FALLS_TO_FREE_BY_ACCESS[access]) {
    return {
      kind: "free",
      memberCapacity: 1,
      storageCapacity: FREE_STORAGE_BYTES,
    };
  }
  return { kind: null, memberCapacity: null, storageCapacity: null };
};

const errorChain = (error: Error): string => {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    if (isRecord(current) && typeof current["constraint"] === "string") {
      parts.push(current["constraint"]);
    }
    current = current.cause;
  }
  return parts.join(" <- ");
};

const readRow = (rows: unknown[]) => {
  const row = rows.at(0);
  return isRecord(row) ? row : undefined;
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("organization effective policy (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("organization effective policy (postgres)", () => {
    test("every access state, entitlement status, cancellation and period position binds the oracle's policy", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const outcome = await db
          .transaction(async (tx) => {
            const nowRow = readRow(
              executedRows(await tx.execute(sql`select now() as now`)),
            );
            const now = new Date(String(nowRow?.["now"]));
            const paidPolicyId = createSafeId<"usagePolicy">();
            await tx.insert(usagePolicies).values({
              id: paidPolicyId,
              policyKey: `effective_paid_${Bun.randomUUIDv7()}`,
              displayName: "Effective paid",
              monthlyUsageUnits: 1,
              priceBasis: "per_seat",
              maxMembers: PAID_MAX_MEMBERS,
              storageBytesPerAssignment: PAID_STORAGE_BYTES_PER_ASSIGNMENT,
            });
            const cases: {
              organizationId: SafeId<"organization">;
              access: AccessCase;
              entitlement: EntitlementCase;
            }[] = [];
            for (const access of ACCESS_CASES) {
              for (const entitlement of ENTITLEMENT_CASES) {
                const organizationId = mintAuthProviderId<"organization">();
                cases.push({ organizationId, access, entitlement });
                await tx.insert(organization).values({
                  id: organizationId,
                  name: "Effective policy",
                  slug: `effective-${organizationId}`,
                  createdAt: now,
                });
                // Seat assignments reference a membership. Members join before
                // any access state or entitlement can bound the organization.
                const memberIds = Array.from({ length: ASSIGNMENTS }, () =>
                  mintAuthProviderIdValue(),
                );
                await tx.insert(user).values(
                  memberIds.map((id) => ({
                    id,
                    name: "Effective policy",
                    email: `${id}@effective.test`,
                  })),
                );
                await tx.insert(member).values(
                  memberIds.map((userId, index) => ({
                    id: mintAuthProviderIdValue(),
                    organizationId,
                    userId,
                    role: index === 0 ? "owner" : "member",
                    createdAt: now,
                  })),
                );
                switch (access) {
                  case "missing":
                    break;
                  case "self_managed_keys":
                    await tx.insert(organizationAccessStates).values({
                      organizationId,
                      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
                    });
                    break;
                  case "evaluation_running":
                  case "evaluation_lapsed":
                    await tx.insert(organizationAccessStates).values({
                      organizationId,
                      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
                      evaluationStartedAt: new Date(
                        now.getTime() - 30 * DAY_IN_MS,
                      ),
                      // An evaluation ending exactly now has lapsed.
                      evaluationEndsAt:
                        access === "evaluation_running"
                          ? new Date(now.getTime() + DAY_IN_MS)
                          : now,
                    });
                    break;
                  case "evaluation_ended":
                    await tx.insert(organizationAccessStates).values({
                      organizationId,
                      state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
                      evaluationStartedAt: new Date(
                        now.getTime() - 30 * DAY_IN_MS,
                      ),
                      evaluationEndsAt: new Date(now.getTime() - DAY_IN_MS),
                      evaluationEndedAt: new Date(now.getTime() - DAY_IN_MS),
                    });
                    break;
                  default:
                    access satisfies never;
                }
                if (entitlement.type === "entitlement") {
                  await tx.insert(usageEntitlements).values({
                    id: createSafeId<"usageEntitlement">(),
                    organizationId,
                    usagePolicyId: paidPolicyId,
                    status: entitlement.status,
                    seats: PAID_SEATS,
                    currentPeriodStart: new Date(
                      now.getTime() - 30 * DAY_IN_MS,
                    ),
                    // A period ending exactly now has ended.
                    currentPeriodEnd:
                      entitlement.period === "running"
                        ? new Date(now.getTime() + DAY_IN_MS)
                        : now,
                    cancelAtPeriodEnd:
                      entitlement.cancelAtPeriodEnd === "scheduled",
                    source: "manual",
                  });
                }
                await tx.insert(usageSeatAssignments).values(
                  memberIds.map((userId) => ({
                    id: createSafeId<"usageSeatAssignment">(),
                    organizationId,
                    userId,
                  })),
                );
              }
            }

            const observe = async (freeFloor: "seeded" | "absent") => {
              for (const { organizationId, access, entitlement } of cases) {
                const row = readRow(
                  executedRows(
                    await tx.execute(sql`
                      select
                        (select policy_kind from organization_effective_policy(${organizationId})) as kind,
                        organization_member_capacity(${organizationId}) as member_capacity,
                        organization_storage_capacity(${organizationId})::text as storage_capacity
                    `),
                  ),
                );
                const storage = row?.["storage_capacity"];
                expect(
                  {
                    access,
                    entitlement,
                    kind: row?.["kind"] ?? null,
                    memberCapacity: row?.["member_capacity"] ?? null,
                    storageCapacity:
                      typeof storage === "string" ? BigInt(storage) : null,
                  },
                  `${access} ${JSON.stringify(entitlement)} ${freeFloor}`,
                ).toEqual({
                  access,
                  entitlement,
                  ...expected(access, entitlement, freeFloor),
                });
              }
            };

            await observe("absent");
            await tx.insert(usagePolicies).values({
              id: createSafeId<"usagePolicy">(),
              policyKey: `effective_free_${Bun.randomUUIDv7()}`,
              displayName: "Effective free",
              kind: "free",
              monthlyUsageUnits: 0,
              maxMembers: 1,
              storageBytesPerAssignment: FREE_STORAGE_BYTES,
              serviceActionsPerPeriod: 3,
            });
            await observe("seeded");
            tx.rollback();
          })
          .then(
            () => "committed" as const,
            (error: unknown) => {
              if (error instanceof TransactionRollbackError) {
                return "rolled_back" as const;
              }
              throw error;
            },
          );
        expect(outcome).toBe("rolled_back");
      });
    });

    test("a downgraded organization keeps its members, refuses new ones, and admits one active free policy", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient({ max: 1 });
        const outcome = await db
          .transaction(async (tx) => {
            await tx.insert(usagePolicies).values({
              id: createSafeId<"usagePolicy">(),
              policyKey: `downgrade_free_${Bun.randomUUIDv7()}`,
              displayName: "Downgrade free",
              kind: "free",
              monthlyUsageUnits: 0,
              maxMembers: 1,
              storageBytesPerAssignment: FREE_STORAGE_BYTES,
              serviceActionsPerPeriod: 3,
            });
            const organizationId = mintAuthProviderId<"organization">();
            const userIds = Array.from({ length: 3 }, () =>
              mintAuthProviderIdValue(),
            );
            await tx.insert(user).values(
              userIds.map((id) => ({
                id,
                name: "Downgrade",
                email: `${id}@downgrade.test`,
              })),
            );
            await tx.insert(organization).values({
              id: organizationId,
              name: "Downgrade",
              slug: `downgrade-${organizationId}`,
              createdAt: new Date(),
            });
            // Two members joined during the evaluation, while nothing bounded
            // the organization; the evaluation then ended.
            await tx.insert(member).values(
              userIds.slice(0, 2).map((userId, index) => ({
                id: mintAuthProviderIdValue(),
                organizationId,
                userId,
                role: index === 0 ? "owner" : "member",
                createdAt: new Date(),
              })),
            );
            await tx.insert(organizationAccessStates).values({
              organizationId,
              state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
              evaluationStartedAt: new Date(Date.now() - 30 * DAY_IN_MS),
              evaluationEndsAt: new Date(Date.now() - DAY_IN_MS),
              evaluationEndedAt: new Date(Date.now() - DAY_IN_MS),
            });

            const refused = await tx
              .transaction(
                async (savepoint) =>
                  await savepoint.insert(member).values({
                    id: mintAuthProviderIdValue(),
                    organizationId,
                    userId: userIds[2] ?? "",
                    role: "member",
                    createdAt: new Date(),
                  }),
              )
              .then(
                () => null,
                (error: unknown) => error,
              );
            expect(
              String(refused instanceof Error && errorChain(refused)),
            ).toContain("organization member capacity reached");
            const members = executedRows(
              await tx.execute(
                sql`select count(*)::int as members from member where organization_id = ${organizationId}`,
              ),
            );
            expect(readRow(members)?.["members"]).toBe(2);

            const second = await tx
              .transaction(
                async (savepoint) =>
                  await savepoint.insert(usagePolicies).values({
                    id: createSafeId<"usagePolicy">(),
                    policyKey: `downgrade_free_two_${Bun.randomUUIDv7()}`,
                    displayName: "Second free",
                    kind: "free",
                    monthlyUsageUnits: 0,
                    maxMembers: 1,
                    storageBytesPerAssignment: FREE_STORAGE_BYTES,
                    serviceActionsPerPeriod: 3,
                  }),
              )
              .then(
                () => null,
                (error: unknown) => error,
              );
            expect(
              String(second instanceof Error && errorChain(second)),
            ).toContain("usage_policies_free_active_uidx");
            tx.rollback();
          })
          .then(
            () => "committed" as const,
            (error: unknown) => {
              if (error instanceof TransactionRollbackError) {
                return "rolled_back" as const;
              }
              throw error;
            },
          );
        expect(outcome).toBe("rolled_back");
      });
    });
  });
}
