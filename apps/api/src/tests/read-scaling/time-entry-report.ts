import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  contacts,
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import report from "@/api/handlers/time-entries/report/get";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  createTestHandlerContext,
  NO_AUDIT,
  NO_DB,
} from "@/api/tests/helpers/handler-context";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";

export const seedTimeEntryReportScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const clientId = createSafeId<"contact">();
  const workspaceId = createSafeId<"workspace">();
  await db.insert(organization).values({
    id: organizationId,
    name: "Report fixture",
    slug: organizationId,
    createdAt: new Date("2020-01-01"),
  });
  // Member capacity needs the organization's access state before a second
  // member joins, as tests that add colleagues do.
  await db.insert(organizationAccessStates).values({
    organizationId,
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  });
  await db.insert(user).values({
    id: userId,
    name: "Report actor",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date("2020-01-01"),
  });
  await db.insert(contacts).values({
    id: clientId,
    organizationId,
    type: "person",
    displayName: "Report client",
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    clientId,
    name: "Report matter",
    reference: workspaceId,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId });
  await db.insert(timeEntries).values(
    Array.from({ length: size }, (_, index) => ({
      id: createSafeId<"timeEntry">(),
      organizationId,
      workspaceId,
      userId,
      approverUserId: userId,
      dateWorked: index < 10 ? "2020-01-15" : "2018-01-15",
      timezoneId: "UTC",
      durationMinutes: 30,
      billedMinutes: 30,
      rateAtEntry: cents(1000),
      currency: "USD",
      narrative: "Report work",
      status: "submitted" as const,
    })),
  );
  const featureAccessSnapshot = enrolledTimeBillingSnapshot({
    organizationId,
    userId,
  });
  const safeDb = createMembershipSafeDb(markRlsDatabase(db), {
    organizationId,
    userId,
    serverValidatedWorkspaceIds: [workspaceId],
    featureAccessSnapshot,
  });
  return {
    db,
    organizationId,
    userId,
    workspaceId,
    clientId,
    context: {
      user: { id: userId },
      session: { activeOrganizationId: organizationId },
      memberRole: sessionMemberRole("owner"),
      safeDb,
      scopedDb: NO_DB,
      audit: NO_AUDIT,
      featureAccessSnapshot,
      getActiveWorkspaceIds: async () => await Promise.resolve([workspaceId]),
      request: new Request("https://example.test/v1/time-entries/report"),
    },
    cleanup: async () => {
      await db.delete(organization).where(eq(organization.id, organizationId));
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

export type TimeEntryReportFixture = Awaited<
  ReturnType<typeof seedTimeEntryReportScaling>
>;

export const timeEntryReportScalingScenario = {
  name: "team time report",
  definition: report,
  measure: async (fixture: TimeEntryReportFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await report.handler(
        createTestHandlerContext<Parameters<typeof report.handler>[0]>({
          ...fixture.context,
          route: "/v1/time-entries/report",
          query: {
            from: "2020-01-01",
            to: "2020-01-31",
            groupBy: "matter",
            bucket: "day",
          },
        }),
      );
      if (!("rows" in response)) {
        return panic("Report scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.rows.length,
      };
    }),
};
