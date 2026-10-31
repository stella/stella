import { panic } from "better-result";
import { eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import updateBillingAccess, {
  createMemberBillingAccessHandler,
} from "@/api/handlers/organization-settings/members/billing-access/update";
import { HttpStatusResponse } from "@/api/http/status";
import { setMemberBillingAccess } from "@/api/lib/auth";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

export const seedMemberBillingScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const users = Array.from({ length: size }, () =>
    mintAuthProviderId<"user">(),
  );
  const actorUserId = users.at(0) ?? panic("Scaling actor missing");
  const targetUserId = users.at(-1) ?? panic("Scaling target missing");
  const targetMemberId = mintAuthProviderIdValue();
  await db.insert(organization).values({
    id: organizationId,
    name: "Member scaling fixture",
    slug: organizationId,
    createdAt: new Date(),
  });
  await recordNewOrganizationAccessState(db, {
    organizationId,
    now: new Date(),
  });
  await db.insert(user).values(
    users.map((id) => ({
      id,
      name: "Scaling member",
      email: `${id}@example.test`,
      emailVerified: true,
    })),
  );
  await db.insert(member).values(
    users.map((userId) => ({
      id: userId === targetUserId ? targetMemberId : mintAuthProviderIdValue(),
      organizationId,
      userId,
      role: userId === actorUserId ? "owner" : "member",
      createdAt: new Date(),
    })),
  );
  return {
    db,
    organizationId,
    actorUserId,
    targetMemberId,
    cleanup: async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(inArray(user.id, users));
    },
  };
};

type MemberBillingFixture = Awaited<
  ReturnType<typeof seedMemberBillingScaling>
>;

export const memberBillingScalingScenario = {
  name: "Member billing visibility assignment",
  definition: updateBillingAccess,
  measure: async ({
    db,
    organizationId,
    actorUserId,
    targetMemberId,
  }: MemberBillingFixture) => {
    const endpoint = createMemberBillingAccessHandler(
      async (options) =>
        await setMemberBillingAccess({ ...options, database: db }),
    );
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await endpoint.handler(
        asTestRaw(
          createTestHandlerContext({
            audit: async () => {
              await Promise.resolve();
            },
            safeDb: NO_DB,
            scopedDb: NO_DB,
            user: { id: actorUserId },
            featureAccessSnapshot: enrolledTimeBillingSnapshot({
              organizationId,
              userId: actorUserId,
            }),
            session: { activeOrganizationId: organizationId },
            memberRole: sessionMemberRole("owner"),
            params: { memberId: targetMemberId },
            body: { billingAccess: true },
            query: {},
          }),
        ),
      );
      if (response instanceof HttpStatusResponse) {
        return panic("Billing assignment scaling requires success");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
      };
    });
  },
};
