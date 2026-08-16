import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  usageEntitlements,
  usagePolicies,
  usageSeatAssignments,
} from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { toSafeId } from "@/api/lib/branded-types";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import assignSeat from "./assign-seat";
import unassignSeat from "./unassign-seat";

setDefaultTimeout(120_000);

const DAY_MS = 86_400_000;
const PERIOD_START = new Date(Date.now() - 10 * DAY_MS);
const PERIOD_END = new Date(Date.now() + 20 * DAY_MS);
/** One purchased seat: the capacity boundary sits between two members. */
const SEATS = 1;

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);

  const policyId = toSafeId<"usagePolicy">(Bun.randomUUIDv7());
  await testDb.insert(usagePolicies).values({
    id: policyId,
    policyKey: `test_policy_${Bun.randomUUIDv7()}`,
    displayName: "Test policy",
    monthlyUsageUnits: 1000,
  });
  await testDb.insert(usageEntitlements).values({
    id: toSafeId<"usageEntitlement">(Bun.randomUUIDv7()),
    organizationId: ids.orgA,
    usagePolicyId: policyId,
    status: "active",
    seats: SEATS,
    currentPeriodStart: PERIOD_START,
    currentPeriodEnd: PERIOD_END,
    source: "manual",
  });
});

afterAll(async () => {
  await releaseTestDb();
});

// The handler persists; each case starts from an empty seat roster so
// capacity is decided by the case's own assignments.
beforeEach(async () => {
  await testDb
    .delete(usageSeatAssignments)
    .where(eq(usageSeatAssignments.organizationId, ids.orgA));
});

type AssignSeatCtx = Parameters<typeof assignSeat.handler>[0];
type UnassignSeatCtx = Parameters<typeof unassignSeat.handler>[0];

const contextOverridesFor = (userId: string) => ({
  body: { userId },
  session: { activeOrganizationId: ids.orgA },
  user: { id: ids.userAdmin },
  safeDb: asTestRaw<SafeDb>(createSafeDb(testDb, [], ids.orgA, ids.userAdmin)),
});

const assignContextFor = (userId: string): AssignSeatCtx =>
  createTestHandlerContext<AssignSeatCtx>(contextOverridesFor(userId));

const unassignContextFor = (userId: string): UnassignSeatCtx =>
  createTestHandlerContext<UnassignSeatCtx>(contextOverridesFor(userId));

const assignedUserIds = async () => {
  const rows = await testDb
    .select({ userId: usageSeatAssignments.userId })
    .from(usageSeatAssignments)
    .where(eq(usageSeatAssignments.organizationId, ids.orgA));
  return rows.map((row) => row.userId);
};

const CAPACITY_REJECTION = {
  code: 409,
  response: { message: "All included per-user limits are assigned" },
} as const;

describe("assign-seat capacity", () => {
  test("assigns a member while the entitlement has a free seat", async () => {
    const result = await assignSeat.handler(assignContextFor(ids.userA1));

    expect(result).toEqual({ assigned: true });
    expect(await assignedUserIds()).toEqual([ids.userA1]);
  });

  test("refuses the assignment that would exceed the entitlement's seats", async () => {
    await assignSeat.handler(assignContextFor(ids.userA1));

    const result = await assignSeat.handler(assignContextFor(ids.userA2));

    expect(result).toMatchObject(CAPACITY_REJECTION);
    expect(await assignedUserIds()).toEqual([ids.userA1]);
  });

  test("re-assigning an already seated member succeeds without taking a second seat", async () => {
    await assignSeat.handler(assignContextFor(ids.userA1));

    // Idempotence matters at the boundary: a retry on the last seat must
    // not read its own row as the seat that fills the plan.
    const result = await assignSeat.handler(assignContextFor(ids.userA1));

    expect(result).toEqual({ assigned: true });
    expect(await assignedUserIds()).toEqual([ids.userA1]);
  });

  test("unassigning releases the seat for another member", async () => {
    await assignSeat.handler(assignContextFor(ids.userA1));
    await unassignSeat.handler(unassignContextFor(ids.userA1));

    const result = await assignSeat.handler(assignContextFor(ids.userA2));

    expect(result).toEqual({ assigned: true });
    expect(await assignedUserIds()).toEqual([ids.userA2]);
  });
});
