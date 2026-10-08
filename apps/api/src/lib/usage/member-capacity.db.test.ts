/**
 * Member capacity and per-member AI access. The capacity function and the
 * member insert guard run in the database; the loaders read AI access under
 * the request scope (role `stella`), so those probes use the
 * membership-scoped factory request authentication builds.
 */

import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";

import { DAY_IN_MS } from "@stll/time";

import { invitation, member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  organizationSettings,
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import type { USAGE_POLICY_PRICE_BASES } from "@/api/db/schema";
import { createMembershipScopedDb } from "@/api/db/scoped";
import { env } from "@/api/env";
import { encryptAIConfig } from "@/api/lib/ai-config-crypto";
import {
  loadOrgAIConfig,
  loadOrgAISettings,
  loadOrgSettingsForAuth,
} from "@/api/lib/ai-config-loader";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import { AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE } from "@/api/lib/ai-config-response";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { decideChatUsageLane } from "@/api/lib/usage/lane-routing";
import {
  checkMemberAdmission,
  checkMemberCapacityChange,
  MEMBER_CAPACITY_BELOW_MEMBERS_ERROR_CODE,
  MEMBER_CAPACITY_REACHED_ERROR_CODE,
  memberCapacityOf,
  memberMayUseAI,
  readOrganizationMemberCapacity,
} from "@/api/lib/usage/member-capacity";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;

const envBefore = env.FEATURE_ORG_ACCESS_STATE;

afterEach(() => {
  env.FEATURE_ORG_ACCESS_STATE = envBefore;
});

const enforce = () => {
  env.FEATURE_ORG_ACCESS_STATE = true;
};

type PriceBasis = (typeof USAGE_POLICY_PRICE_BASES)[number];
type AccessState =
  (typeof ORGANIZATION_ACCESS_STATE)[keyof typeof ORGANIZATION_ACCESS_STATE];

const PERIOD_START = new Date("2026-01-01T00:00:00.000Z");
const PERIOD_END = new Date("2099-01-01T00:00:00.000Z");

const insertUser = async (
  db: Pick<Transaction, "insert">,
): Promise<SafeId<"user">> => {
  const userId = mintAuthProviderId<"user">();
  await db.insert(user).values({
    id: userId,
    name: "Capacity fixture",
    email: `${userId}@capacity.test`,
  });
  return userId;
};

const insertMember = async (
  db: Pick<Transaction, "insert">,
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
): Promise<void> => {
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "member",
    createdAt: new Date(),
  });
};

type OrganizationShape = {
  state: AccessState | null;
  entitlement: {
    priceBasis: PriceBasis;
    maxMembers: number | null;
    seats: number;
  } | null;
};

const insertOrganization = async (
  db: Pick<Transaction, "insert">,
  { state, entitlement }: OrganizationShape,
): Promise<SafeId<"organization">> => {
  const organizationId = mintAuthProviderId<"organization">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Capacity fixture",
    slug: `capacity-${organizationId}`,
    createdAt: new Date(),
  });
  if (state === ORGANIZATION_ACCESS_STATE.selfManagedKeys) {
    await db.insert(organizationAccessStates).values({ organizationId, state });
  } else if (state !== null) {
    const now = Date.now();
    await db.insert(organizationAccessStates).values({
      organizationId,
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      evaluationStartedAt: new Date(now - DAY_IN_MS),
      evaluationEndsAt: new Date(now + DAY_IN_MS),
    });
  }
  if (entitlement) {
    const usagePolicyId = createSafeId<"usagePolicy">();
    await db.insert(usagePolicies).values({
      id: usagePolicyId,
      policyKey: `capacity_${Bun.randomUUIDv7()}`,
      displayName: "Capacity fixture",
      monthlyUsageUnits: 7,
      priceBasis: entitlement.priceBasis,
      maxMembers: entitlement.maxMembers,
    });
    await db.insert(usageEntitlements).values({
      id: createSafeId<"usageEntitlement">(),
      organizationId,
      usagePolicyId,
      status: "active",
      seats: entitlement.seats,
      currentPeriodStart: PERIOD_START,
      currentPeriodEnd: PERIOD_END,
      source: "manual",
    });
  }
  return organizationId;
};

const withRolledBackTx = async (
  fn: (tx: Transaction) => Promise<void>,
): Promise<void> => {
  try {
    await testDb.transaction(async (rawTx) => {
      // SAFETY: PGlite drizzle transaction is structurally compatible
      // with prod BunSQL transaction for the queries we run here.
      await fn(asTestRaw<Transaction>(rawTx));
      rawTx.rollback();
    });
  } catch (error) {
    if (error instanceof TransactionRollbackError) {
      return;
    }
    throw error;
  }
};

const capacityInDatabase = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<number | null> => {
  const rows = await tx
    .select({
      capacity: sql<
        number | null
      >`organization_member_capacity(${organizationId})`,
    })
    .from(organization)
    .where(eq(organization.id, organizationId));
  return rows.at(0)?.capacity ?? null;
};

const errorChainText = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" <- ");
};

/** Inserts one more member in a savepoint; the guard's refusal is a result. */
const tryAddMember = async (
  tx: Transaction,
  organizationId: SafeId<"organization">,
): Promise<"added" | "refused"> => {
  const userId = await insertUser(tx);
  const added = await Result.tryPromise(
    async () =>
      await tx.transaction(async (savepoint) => {
        await insertMember(savepoint, organizationId, userId);
      }),
  );
  if (Result.isOk(added)) {
    return "added";
  }
  expect(errorChainText(added.error)).toContain(
    "organization member capacity reached",
  );
  return "refused";
};

beforeAll(async () => {
  testDb = await getTestDb();
});

afterAll(async () => {
  await releaseTestDb();
});

describe("organization_member_capacity", () => {
  const cases: {
    name: string;
    shape: OrganizationShape;
    expected: number | null;
  }[] = [
    {
      name: "a per-seat policy bounds by its seats below its member bound",
      shape: {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: 10, seats: 3 },
      },
      expected: 3,
    },
    {
      name: "a per-seat policy without a member bound is unbounded",
      shape: {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: null, seats: 1 },
      },
      expected: null,
    },
    {
      name: "a member bound below the seats wins",
      shape: {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: 2, seats: 5 },
      },
      expected: 2,
    },
    {
      name: "a flat policy bounds by its member bound only",
      shape: {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "flat", maxMembers: 4, seats: 1 },
      },
      expected: 4,
    },
    {
      name: "a flat policy without a member bound is unbounded",
      shape: {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "flat", maxMembers: null, seats: 1 },
      },
      expected: null,
    },
    {
      name: "self-managed keys are never bounded",
      shape: {
        state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        entitlement: { priceBasis: "per_seat", maxMembers: 1, seats: 1 },
      },
      expected: null,
    },
    {
      name: "an organization without a recorded state is not bounded",
      shape: {
        state: null,
        entitlement: { priceBasis: "per_seat", maxMembers: 1, seats: 1 },
      },
      expected: null,
    },
    {
      name: "an organization without an entitlement is not bounded",
      shape: {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: null,
      },
      expected: null,
    },
  ];

  for (const { name, shape, expected } of cases) {
    test(name, async () => {
      await withRolledBackTx(async (tx) => {
        const organizationId = await insertOrganization(tx, shape);
        expect(await capacityInDatabase(tx, organizationId)).toBe(expected);
        if (shape.entitlement) {
          // The application's projection agrees with the database function
          // wherever the state leaves the organization bounded.
          const projected = memberCapacityOf(shape.entitlement);
          if (
            shape.state !== ORGANIZATION_ACCESS_STATE.selfManagedKeys &&
            shape.state !== null
          ) {
            expect(projected).toBe(expected);
          }
        }
      });
    });
  }
});

describe("member insert guard", () => {
  test("refuses the member past capacity and admits up to it", async () => {
    await withRolledBackTx(async (tx) => {
      const organizationId = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: 10, seats: 2 },
      });
      expect(await tryAddMember(tx, organizationId)).toBe("added");
      expect(await tryAddMember(tx, organizationId)).toBe("added");
      expect(await tryAddMember(tx, organizationId)).toBe("refused");
    });
  });

  test("leaves a per-seat entitlement whose policy sets no member bound unbounded", async () => {
    await withRolledBackTx(async (tx) => {
      const organizationId = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: null, seats: 1 },
      });
      for (let index = 0; index < 3; index += 1) {
        expect(await tryAddMember(tx, organizationId)).toBe("added");
      }
      expect(await readOrganizationMemberCapacity(tx, organizationId)).toBe(
        null,
      );
      const admission = await checkMemberAdmission(tx, {
        organizationId,
        kind: "invitation",
      });
      expect(Result.isOk(admission)).toBe(true);
    });
  });

  test("never bounds an organization on self-managed keys", async () => {
    await withRolledBackTx(async (tx) => {
      const organizationId = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        entitlement: { priceBasis: "per_seat", maxMembers: 1, seats: 1 },
      });
      for (let index = 0; index < 3; index += 1) {
        expect(await tryAddMember(tx, organizationId)).toBe("added");
      }
    });
  });

  test("a raised seat count admits the next member", async () => {
    await withRolledBackTx(async (tx) => {
      const organizationId = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: 10, seats: 1 },
      });
      expect(await tryAddMember(tx, organizationId)).toBe("added");
      expect(await tryAddMember(tx, organizationId)).toBe("refused");
      await tx
        .update(usageEntitlements)
        .set({ seats: 2 })
        .where(sql`${usageEntitlements.organizationId} = ${organizationId}`);
      expect(await tryAddMember(tx, organizationId)).toBe("added");
    });
  });
});

describe("checkMemberAdmission", () => {
  test("refuses readably where the database bound applies, whatever the flag", async () => {
    env.FEATURE_ORG_ACCESS_STATE = false;
    await withRolledBackTx(async (tx) => {
      const organizationId = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: 1, seats: 1 },
      });
      await insertMember(tx, organizationId, await insertUser(tx));
      expect(await readOrganizationMemberCapacity(tx, organizationId)).toBe(1);
      for (const kind of ["membership", "invitation"] as const) {
        const admission = await checkMemberAdmission(tx, {
          organizationId,
          kind,
        });
        expect(Result.isError(admission) && admission.error.code).toBe(
          MEMBER_CAPACITY_REACHED_ERROR_CODE,
        );
      }
      // The insert the refusal prevents is the one the trigger stops.
      expect(await tryAddMember(tx, organizationId)).toBe("refused");
    });
  });

  test("admits as before where no policy sets a member bound, with the flag off", async () => {
    env.FEATURE_ORG_ACCESS_STATE = false;
    await withRolledBackTx(async (tx) => {
      const organizationId = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: null, seats: 1 },
      });
      await insertMember(tx, organizationId, await insertUser(tx));
      expect(await readOrganizationMemberCapacity(tx, organizationId)).toBe(
        null,
      );
      for (const kind of ["membership", "invitation"] as const) {
        const admission = await checkMemberAdmission(tx, {
          organizationId,
          kind,
        });
        expect(Result.isOk(admission)).toBe(true);
      }
      expect(await tryAddMember(tx, organizationId)).toBe("added");
    });
  });

  test("counts pending invitations against the capacity, not expired ones", async () => {
    await withRolledBackTx(async (tx) => {
      const organizationId = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: 10, seats: 3 },
      });
      const inviterId = await insertUser(tx);
      await insertMember(tx, organizationId, inviterId);
      const now = new Date();
      const invite = async (expiresAt: Date) =>
        await tx.insert(invitation).values({
          id: mintAuthProviderIdValue(),
          organizationId,
          email: `${Bun.randomUUIDv7()}@capacity.test`,
          role: "member",
          status: "pending",
          expiresAt,
          inviterId,
        });
      await invite(new Date(now.getTime() - DAY_IN_MS));
      await invite(new Date(now.getTime() + DAY_IN_MS));

      // One member and one live invitation leave one place.
      const third = await checkMemberAdmission(tx, {
        organizationId,
        kind: "invitation",
      });
      expect(Result.isOk(third)).toBe(true);

      await invite(new Date(now.getTime() + DAY_IN_MS));
      const fourth = await checkMemberAdmission(tx, {
        organizationId,
        kind: "invitation",
      });
      expect(Result.isError(fourth) && fourth.error.code).toBe(
        MEMBER_CAPACITY_REACHED_ERROR_CODE,
      );

      // Accepting one of the invitations still fits: only members count.
      const accept = await checkMemberAdmission(tx, {
        organizationId,
        kind: "membership",
      });
      expect(Result.isOk(accept)).toBe(true);
    });
  });

  test("refuses a membership at capacity", async () => {
    await withRolledBackTx(async (tx) => {
      const organizationId = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "flat", maxMembers: 1, seats: 1 },
      });
      await insertMember(tx, organizationId, await insertUser(tx));
      const admission = await checkMemberAdmission(tx, {
        organizationId,
        kind: "membership",
      });
      expect(Result.isError(admission) && admission.error.code).toBe(
        MEMBER_CAPACITY_REACHED_ERROR_CODE,
      );
    });
  });
});

describe("checkMemberCapacityChange", () => {
  test("refuses a capacity below the current members and removes nobody", async () => {
    await withRolledBackTx(async (tx) => {
      const organizationId = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: { priceBasis: "per_seat", maxMembers: 10, seats: 3 },
      });
      for (let index = 0; index < 3; index += 1) {
        await insertMember(tx, organizationId, await insertUser(tx));
      }
      const lower = await checkMemberCapacityChange(tx, {
        organizationId,
        nextCapacity: 2,
      });
      expect(Result.isError(lower) && lower.error.code).toBe(
        MEMBER_CAPACITY_BELOW_MEMBERS_ERROR_CODE,
      );
      const equal = await checkMemberCapacityChange(tx, {
        organizationId,
        nextCapacity: 3,
      });
      expect(Result.isOk(equal)).toBe(true);
      const members = await tx
        .select({ id: member.id })
        .from(member)
        .where(sql`${member.organizationId} = ${organizationId}`);
      expect(members).toHaveLength(3);
    });
  });

  test("never refuses an organization on self-managed keys or a change to no bound", async () => {
    env.FEATURE_ORG_ACCESS_STATE = false;
    await withRolledBackTx(async (tx) => {
      const selfManaged = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        entitlement: null,
      });
      const bounded = await insertOrganization(tx, {
        state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
        entitlement: null,
      });
      for (const organizationId of [selfManaged, bounded]) {
        await insertMember(tx, organizationId, await insertUser(tx));
        await insertMember(tx, organizationId, await insertUser(tx));
      }
      const unbounded = await checkMemberCapacityChange(tx, {
        organizationId: bounded,
        nextCapacity: null,
      });
      expect(Result.isOk(unbounded)).toBe(true);
      const exempt = await checkMemberCapacityChange(tx, {
        organizationId: selfManaged,
        nextCapacity: 1,
      });
      expect(Result.isOk(exempt)).toBe(true);
      // A bound the trigger would enforce is checked with the flag off too.
      const lower = await checkMemberCapacityChange(tx, {
        organizationId: bounded,
        nextCapacity: 1,
      });
      expect(Result.isError(lower) && lower.error.code).toBe(
        MEMBER_CAPACITY_BELOW_MEMBERS_ERROR_CODE,
      );
    });
  });
});

describe("AI access for members", () => {
  let boundedOrgId: SafeId<"organization">;
  let selfManagedOrgId: SafeId<"organization">;
  let unboundedOrgId: SafeId<"organization">;
  let unlimitedPolicyOrgId: SafeId<"organization">;
  let assignedUserId: SafeId<"user">;
  let unassignedUserId: SafeId<"user">;
  const fixtureOrgIds: SafeId<"organization">[] = [];
  const fixtureUserIds: SafeId<"user">[] = [];

  const requestScope = (
    organizationId: SafeId<"organization">,
    userId: SafeId<"user">,
  ): ScopedDb =>
    asTestRaw<ScopedDb>(
      createMembershipScopedDb(testDb, {
        organizationId,
        serverValidatedWorkspaceIds: [],
        userId,
      }),
    );

  beforeAll(async () => {
    const owner = asTestRaw<Transaction>(testDb);
    assignedUserId = await insertUser(owner);
    unassignedUserId = await insertUser(owner);
    fixtureUserIds.push(assignedUserId, unassignedUserId);
    boundedOrgId = await insertOrganization(owner, {
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      entitlement: { priceBasis: "per_seat", maxMembers: 10, seats: 2 },
    });
    selfManagedOrgId = await insertOrganization(owner, {
      state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
      entitlement: { priceBasis: "per_seat", maxMembers: 10, seats: 2 },
    });
    unboundedOrgId = await insertOrganization(owner, {
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      entitlement: null,
    });
    unlimitedPolicyOrgId = await insertOrganization(owner, {
      state: ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      entitlement: { priceBasis: "per_seat", maxMembers: null, seats: 2 },
    });
    fixtureOrgIds.push(
      boundedOrgId,
      selfManagedOrgId,
      unboundedOrgId,
      unlimitedPolicyOrgId,
    );
    for (const organizationId of fixtureOrgIds) {
      await insertMember(owner, organizationId, assignedUserId);
      await insertMember(owner, organizationId, unassignedUserId);
      await owner.insert(usageSeatAssignments).values({
        organizationId,
        userId: assignedUserId,
      });
    }
    // The bounded organization runs on its own key: a seat is required
    // whichever key would serve the work.
    const ownConfig = await encryptAIConfig(boundedOrgId, {
      providers: [{ provider: "google", apiKey: "own-key" }],
      overrideModels: {
        chat: { provider: "google", modelId: "model-a" },
        fast: { provider: "google", modelId: "model-a" },
        pdf: { provider: "google", modelId: "model-a" },
        reasoning: { provider: "google", modelId: "model-a" },
      },
      decision: null,
    });
    await owner.insert(organizationSettings).values({
      id: createSafeId<"organizationSettings">(),
      organizationId: boundedOrgId,
      aiConfigEncrypted: ownConfig.ciphertext,
      aiConfigIv: ownConfig.iv,
    });
  });

  afterAll(async () => {
    await testDb
      .delete(organization)
      .where(inArray(organization.id, fixtureOrgIds));
    await testDb.delete(user).where(inArray(user.id, fixtureUserIds));
  });

  const authStatus = async (
    organizationId: SafeId<"organization">,
    userId: SafeId<"user">,
  ) =>
    (
      await requestScope(
        organizationId,
        userId,
      )(
        async (tx) =>
          await loadOrgSettingsForAuth(tx, { organizationId, userId }),
      )
    ).orgAIConfigStatus;

  const strictLoadCodes = async (
    organizationId: SafeId<"organization">,
    userId: SafeId<"user">,
  ): Promise<(string | null)[]> => {
    const scope = requestScope(organizationId, userId);
    const reader = { organizationId, userId };
    const results: Result<unknown, HandlerError<403>>[] = [
      await scope(async (tx) => await loadOrgAIConfig(tx, reader)),
      await scope(async (tx) => await loadOrgAISettings(tx, reader)),
    ];
    return results.map((result) =>
      Result.isError(result) ? (result.error.code ?? "error") : null,
    );
  };

  test("the flag off changes nothing for an unassigned member", async () => {
    expect(await authStatus(boundedOrgId, unassignedUserId)).toBe(
      ORG_AI_CONFIG_STATUS.ok,
    );
    expect(await strictLoadCodes(boundedOrgId, unassignedUserId)).toEqual([
      null,
      null,
    ]);
    expect(
      await memberMayUseAI(
        asTestRaw<Transaction>(testDb),
        boundedOrgId,
        unassignedUserId,
      ),
    ).toBe(true);
  });

  test("an unassigned member is refused even on the organization's own key", async () => {
    enforce();
    expect(await authStatus(boundedOrgId, unassignedUserId)).toBe(
      ORG_AI_CONFIG_STATUS.memberAssignmentRequired,
    );
    expect(await strictLoadCodes(boundedOrgId, unassignedUserId)).toEqual([
      AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE,
      AI_MEMBER_ASSIGNMENT_REQUIRED_ERROR_CODE,
    ]);
  });

  test("an assigned member keeps AI access", async () => {
    enforce();
    expect(await authStatus(boundedOrgId, assignedUserId)).toBe(
      ORG_AI_CONFIG_STATUS.ok,
    );
    expect(await strictLoadCodes(boundedOrgId, assignedUserId)).toEqual([
      null,
      null,
    ]);
  });

  test("self-managed keys and organizations without a member bound need no seat", async () => {
    enforce();
    for (const organizationId of [
      selfManagedOrgId,
      unboundedOrgId,
      unlimitedPolicyOrgId,
    ]) {
      expect(
        await memberMayUseAI(
          asTestRaw<Transaction>(testDb),
          organizationId,
          unassignedUserId,
        ),
      ).toBe(true);
    }
    // Self-managed keys still keep the own-key rule of the access state.
    expect(await authStatus(selfManagedOrgId, unassignedUserId)).toBe(
      ORG_AI_CONFIG_STATUS.ownKeyRequired,
    );
  });

  test("lane routing never sends an unassigned member to the pool", async () => {
    enforce();
    await withRolledBackTx(async (tx) => {
      expect(
        await decideChatUsageLane({
          tx,
          organizationId: boundedOrgId,
          userId: unassignedUserId,
        }),
      ).toBe("unassigned");
      // The fixture policy declares no per-user budgets, so an assigned
      // member lands on the pool exactly as before.
      expect(
        await decideChatUsageLane({
          tx,
          organizationId: boundedOrgId,
          userId: assignedUserId,
        }),
      ).toBe("pool");
      expect(
        await decideChatUsageLane({
          tx,
          organizationId: selfManagedOrgId,
          userId: unassignedUserId,
        }),
      ).toBe("pool");
    });
  });

  test("lane routing is unchanged while the flag is off", async () => {
    await withRolledBackTx(async (tx) => {
      expect(
        await decideChatUsageLane({
          tx,
          organizationId: boundedOrgId,
          userId: unassignedUserId,
        }),
      ).toBe("pool");
    });
  });
});

describe("the free floor", () => {
  const insertFreePolicy = async (db: Pick<Transaction, "insert">) => {
    await db.insert(usagePolicies).values({
      id: createSafeId<"usagePolicy">(),
      policyKey: `free_${Bun.randomUUIDv7()}`,
      displayName: "Free fixture",
      kind: "free",
      monthlyUsageUnits: 0,
      maxMembers: 1,
      storageBytesPerAssignment: 1_073_741_824n,
      serviceActionsPerPeriod: 3,
    });
  };

  const insertEndedEvaluation = async (
    db: Pick<Transaction, "insert">,
    organizationId: SafeId<"organization">,
  ) => {
    const now = Date.now();
    await db.insert(organizationAccessStates).values({
      organizationId,
      state: ORGANIZATION_ACCESS_STATE.evaluationEnded,
      evaluationStartedAt: new Date(now - 30 * DAY_IN_MS),
      evaluationEndsAt: new Date(now - DAY_IN_MS),
      evaluationEndedAt: new Date(now - DAY_IN_MS),
    });
  };

  test("a downgraded organization keeps every member, admits nobody new, and keeps AI for all", async () => {
    enforce();
    await withRolledBackTx(async (tx) => {
      await insertFreePolicy(tx);
      const organizationId = await insertOrganization(tx, {
        state: null,
        entitlement: null,
      });
      const members = [await insertUser(tx), await insertUser(tx)];
      for (const userId of members) {
        await insertMember(tx, organizationId, userId);
      }
      await insertEndedEvaluation(tx, organizationId);

      expect(await readOrganizationMemberCapacity(tx, organizationId)).toBe(1);
      const admission = await checkMemberAdmission(tx, {
        organizationId,
        kind: "invitation",
      });
      expect(Result.isError(admission)).toBe(true);
      const refused = await tx
        .transaction(
          async (savepoint) =>
            await insertMember(savepoint, organizationId, await insertUser(tx)),
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(refused).toBeInstanceOf(Error);
      expect(
        (
          await tx
            .select({ userId: member.userId })
            .from(member)
            .where(eq(member.organizationId, organizationId))
        ).map((row) => row.userId),
      ).toHaveLength(2);
      // Seats bound paid plans only: no member needs one on the free floor.
      for (const userId of members) {
        expect(await memberMayUseAI(tx, organizationId, userId)).toBe(true);
      }
    });
  });

  test("a scheduled cancellation keeps paid limits until the period end, then falls to the free floor", async () => {
    await withRolledBackTx(async (tx) => {
      await insertFreePolicy(tx);
      const organizationId = await insertOrganization(tx, {
        state: null,
        entitlement: { priceBasis: "flat", maxMembers: 5, seats: 5 },
      });
      await insertEndedEvaluation(tx, organizationId);
      await tx
        .update(usageEntitlements)
        .set({ status: "cancelled", cancelAtPeriodEnd: true })
        .where(eq(usageEntitlements.organizationId, organizationId));
      expect(await readOrganizationMemberCapacity(tx, organizationId)).toBe(5);

      await tx
        .update(usageEntitlements)
        .set({ currentPeriodEnd: new Date(Date.now() - DAY_IN_MS) })
        .where(eq(usageEntitlements.organizationId, organizationId));
      expect(await readOrganizationMemberCapacity(tx, organizationId)).toBe(1);
    });
  });

  test("past-due and paused entitlements keep paid limits", async () => {
    await withRolledBackTx(async (tx) => {
      await insertFreePolicy(tx);
      for (const status of ["past_due", "paused"] as const) {
        const organizationId = await insertOrganization(tx, {
          state: null,
          entitlement: { priceBasis: "flat", maxMembers: 5, seats: 5 },
        });
        await insertEndedEvaluation(tx, organizationId);
        await tx
          .update(usageEntitlements)
          .set({ status, currentPeriodEnd: new Date(Date.now() - DAY_IN_MS) })
          .where(eq(usageEntitlements.organizationId, organizationId));
        expect(await readOrganizationMemberCapacity(tx, organizationId)).toBe(
          5,
        );
      }
    });
  });

  test("self-managed keys and running evaluations never fall to the free floor", async () => {
    await withRolledBackTx(async (tx) => {
      await insertFreePolicy(tx);
      for (const state of [
        ORGANIZATION_ACCESS_STATE.selfManagedKeys,
        ORGANIZATION_ACCESS_STATE.evaluationPeriod,
      ]) {
        const organizationId = await insertOrganization(tx, {
          state,
          entitlement: null,
        });
        expect(
          await readOrganizationMemberCapacity(tx, organizationId),
        ).toBeNull();
      }
    });
  });
});
