import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import { member, user } from "@/api/db/auth-schema";
import { createSafeDb } from "@/api/db/scoped";
import listWorkspaceMemberCandidates from "@/api/handlers/workspaces/member-candidates/list";
import { HttpStatusResponse } from "@/api/http/status";
import type { SafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithMeasuredQueryCounter,
} from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { mintAuthProviderIdValue } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

type SeedOptions = {
  /** The caller's organization, whose people the read lists. */
  organizationId: SafeId<"organization">;
  /** Another organization, whose growing membership the read must not walk. */
  otherOrganizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  size: number;
};

/**
 * Seeds `size` people into another organization, so the population of
 * memberships grows while the caller's own organization, and so the list,
 * stays the same.
 */
export const seedMemberCandidatesScaling = async (
  database: TestDatabase,
  { organizationId, otherOrganizationId, userId, size }: SeedOptions,
) => {
  const userIds = Array.from({ length: size }, () => mintAuthProviderIdValue());
  await database.insert(user).values(
    userIds.map((id) => ({
      id,
      name: `Colleague ${id}`,
      email: `${id}@scaling.test`,
    })),
  );
  await database.insert(member).values(
    userIds.map((id) => ({
      id: mintAuthProviderIdValue(),
      organizationId: otherOrganizationId,
      userId: id,
      role: "member",
      createdAt: new Date(),
    })),
  );
  return {
    cleanup: async () => {
      await database.delete(user).where(inArray(user.id, userIds));
    },
    database: withQueryLogger(database, queryCountLogger),
    organizationId,
    userId,
  };
};

type MemberCandidatesFixture = Awaited<
  ReturnType<typeof seedMemberCandidatesScaling>
>;

export const memberCandidatesScalingScenario = {
  name: "matter member candidates",
  definition: listWorkspaceMemberCandidates,
  measure: async (fixture: MemberCandidatesFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await listWorkspaceMemberCandidates.handler(
        asTestRaw<Parameters<typeof listWorkspaceMemberCandidates.handler>[0]>({
          query: {},
          request: new Request(
            "https://example.test/v1/workspaces/member-candidates",
          ),
          route: "/v1/workspaces/member-candidates",
          safeDb: createSafeDb(
            fixture.database,
            [],
            fixture.organizationId,
            fixture.userId,
          ),
          session: { activeOrganizationId: fixture.organizationId },
          user: { id: fixture.userId },
          memberRole: sessionMemberRole("member"),
        }),
      );
      if (response instanceof HttpStatusResponse || !("members" in response)) {
        return panic("Member candidate scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.members.length,
      };
    }),
};
