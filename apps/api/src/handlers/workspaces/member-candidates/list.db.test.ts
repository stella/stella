import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";

import { createTestClock } from "@stll/test-kit";

import { member, user } from "@/api/db/auth-schema";
import { createSafeDb } from "@/api/db/scoped";
import type { SafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";
import {
  memberCandidatesScalingScenario,
  seedMemberCandidatesScaling,
} from "@/api/tests/read-scaling/member-candidates";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import listWorkspaceMemberCandidates from "./list";

// Fixture membership (rls-helpers): org A holds userA1, userA2 and the
// admin; org B holds userA1 and userB1.
let testDb: TestDatabase;
let ids: TestIds;

const clock = createTestClock();

/** The fixture gives each person an address under their own id. */
const emailOf = (userId: string) => expect.stringMatching(`^${userId}@`);
const departedUserId = mintAuthProviderIdValue();

beforeAll(async () => {
  const fixture = await getRlsFixture();
  testDb = fixture.testDb;
  ids = fixture.ids;
  // A colleague whose account is gone keeps their membership row.
  await testDb.insert(user).values({
    id: departedUserId,
    name: "Departed colleague",
    email: `${departedUserId}@example.com`,
    deletedAt: new Date(clock.now()),
  });
  await testDb.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId: ids.orgA,
    userId: departedUserId,
    role: "member",
    createdAt: new Date(clock.now()),
  });
});

afterAll(async () => {
  await testDb.delete(user).where(inArray(user.id, [departedUserId]));
  await releaseRlsFixture();
});

const list = async (
  organizationId: SafeId<"organization">,
  userId: SafeId<"user">,
) =>
  await listWorkspaceMemberCandidates.handler(
    asTestRaw<Parameters<typeof listWorkspaceMemberCandidates.handler>[0]>({
      query: {},
      request: new Request(
        "https://example.test/v1/workspaces/member-candidates",
      ),
      route: "/v1/workspaces/member-candidates",
      safeDb: createSafeDb(testDb, [], organizationId, userId),
      session: { activeOrganizationId: organizationId },
      user: { id: userId },
      memberRole: sessionMemberRole("member"),
    }),
  );

describe("GET /v1/workspaces/member-candidates", () => {
  test("lists the caller's organization by name, and no one from another", async () => {
    expect(await list(ids.orgA, ids.userA2)).toEqual({
      members: [
        {
          userId: ids.userAdmin,
          name: "Admin",
          email: emailOf(ids.userAdmin),
          image: null,
        },
        {
          userId: ids.userA1,
          name: "User A1",
          email: emailOf(ids.userA1),
          image: null,
        },
        {
          userId: ids.userA2,
          name: "User A2",
          email: emailOf(ids.userA2),
          image: null,
        },
      ],
    });
    expect(await list(ids.orgB, ids.userB1)).toEqual({
      members: [
        {
          userId: ids.userA1,
          name: "User A1",
          email: emailOf(ids.userA1),
          image: null,
        },
        {
          userId: ids.userB1,
          name: "User B1",
          email: emailOf(ids.userB1),
          image: null,
        },
      ],
    });
  });

  test("a read costs the same however many people other organizations hold", async () => {
    const seed = async (size: number) =>
      await seedMemberCandidatesScaling(testDb, {
        organizationId: ids.orgA,
        otherOrganizationId: ids.orgB,
        userId: ids.userA2,
        size,
      });
    const small = await seed(10);
    const large = await seed(200);
    try {
      const at10 = await memberCandidatesScalingScenario.measure(small);
      const at200 = await memberCandidatesScalingScenario.measure(large);
      expect(at10.rows).toBe(3);
      expect(at200.rows).toBe(3);
      expect(at10.statements).toBeGreaterThan(0);
      expect(readScalingViolations({ small: at10, large: at200 })).toEqual([]);
    } finally {
      await small.cleanup();
      await large.cleanup();
    }
  });
});
