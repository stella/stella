import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { TimeEntryReportQuery } from "@stll/api-contract/time-entry-report";

import { member as authMember, user as authUser } from "@/api/db/auth-schema";
import {
  contacts,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createMembershipSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { createTestHandlerContext } from "@/api/tests/helpers/handler-context";
import { enrolledTimeBillingSnapshot } from "@/api/tests/helpers/time-billing-enrolment";
import {
  seedTimeEntryReportScaling,
  type TimeEntryReportFixture,
} from "@/api/tests/read-scaling/time-entry-report";

import report from "./get";

const query = {
  from: "2020-01-01",
  to: "2020-01-31",
  groupBy: "member",
  bucket: "day",
} satisfies TimeEntryReportQuery;
const read = async (
  fixture: TimeEntryReportFixture,
  overrides: Partial<TimeEntryReportQuery> = {},
  role: "owner" | "member" = "owner",
) => {
  const response = await report.handler(
    createTestHandlerContext<Parameters<typeof report.handler>[0]>({
      ...fixture.context,
      memberRole: sessionMemberRole(role),
      route: "/v1/time-entries/report",
      query: { ...query, ...overrides },
    }),
  );
  if (response instanceof HttpStatusResponse || !("rows" in response)) {
    return panic("Expected report response");
  }
  return response;
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "team time report",
  () => {
    test("shows approvers the team and everyone else their own time, within tenant and matter boundaries", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const fixture = await seedTimeEntryReportScaling(db, 10);
          const other = await seedTimeEntryReportScaling(db, 10);
          try {
            await db.insert(authMember).values({
              id: mintAuthProviderIdValue(),
              organizationId: fixture.organizationId,
              userId: other.userId,
              role: "member",
              createdAt: new Date("2020-01-01"),
            });
            await db.insert(timeEntries).values({
              id: createSafeId<"timeEntry">(),
              organizationId: fixture.organizationId,
              workspaceId: fixture.workspaceId,
              userId: other.userId,
              approverUserId: other.userId,
              dateWorked: "2020-01-15",
              timezoneId: "UTC",
              durationMinutes: 99,
              billedMinutes: 99,
              rateAtEntry: cents(1000),
              currency: "USD",
              narrative: "Colleague's time with another approver",
              status: "submitted",
            });
            // Without approval access a member reports only their own time.
            expect(
              (await read(fixture, {}, "member")).summary.current
                .recordedMinutes,
            ).toBe(300);
            // An approver sees the colleague's time whoever approves it.
            expect((await read(fixture)).summary.current.recordedMinutes).toBe(
              399,
            );
            const inaccessible = {
              ...fixture,
              context: {
                ...fixture.context,
                user: { id: other.userId },
                featureAccessSnapshot: enrolledTimeBillingSnapshot({
                  organizationId: fixture.organizationId,
                  userId: other.userId,
                }),
                safeDb: createMembershipSafeDb(markRlsDatabase(db), {
                  organizationId: fixture.organizationId,
                  userId: other.userId,
                  serverValidatedWorkspaceIds: [],
                  featureAccessSnapshot: enrolledTimeBillingSnapshot({
                    organizationId: fixture.organizationId,
                    userId: other.userId,
                  }),
                }),
              },
            };
            expect((await read(inaccessible, {}, "member")).rows).toEqual([]);
            expect((await read(other)).summary.current.recordedMinutes).toBe(
              300,
            );
          } finally {
            await other.cleanup();
            await fixture.cleanup();
          }
        },
      );
    }, 120_000); // timeout: exercises scoped report reads against two PostgreSQL tenants
    test("groups the same visible minutes by member, matter and client and compares equal periods", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const fixture = await seedTimeEntryReportScaling(
            openClient({ max: 1 }).db,
            10,
          );
          const secondUserId = mintAuthProviderId<"user">();
          const secondClientId = createSafeId<"contact">();
          const secondMatterId = createSafeId<"workspace">();
          try {
            await fixture.db.insert(authUser).values({
              id: secondUserId,
              name: "Second report member",
              email: `${secondUserId}@example.test`,
              emailVerified: true,
            });
            await fixture.db.insert(authMember).values({
              id: mintAuthProviderIdValue(),
              organizationId: fixture.organizationId,
              userId: secondUserId,
              role: "member",
              createdAt: new Date("2020-01-01"),
            });
            await fixture.db.insert(contacts).values({
              id: secondClientId,
              organizationId: fixture.organizationId,
              type: "person",
              displayName: "Second report client",
            });
            await fixture.db.insert(workspaces).values({
              id: secondMatterId,
              organizationId: fixture.organizationId,
              clientId: secondClientId,
              name: "Second report matter",
              reference: secondMatterId,
            });
            await fixture.db.insert(workspaceMembers).values([
              { workspaceId: secondMatterId, userId: fixture.userId },
              { workspaceId: secondMatterId, userId: secondUserId },
            ]);
            const visibleMatters = [fixture.workspaceId, secondMatterId];
            const reportFixture = {
              ...fixture,
              context: {
                ...fixture.context,
                getActiveWorkspaceIds: async () => visibleMatters,
                safeDb: createMembershipSafeDb(markRlsDatabase(fixture.db), {
                  organizationId: fixture.organizationId,
                  userId: fixture.userId,
                  serverValidatedWorkspaceIds: visibleMatters,
                  featureAccessSnapshot: fixture.context.featureAccessSnapshot,
                }),
              },
            };
            await fixture.db.insert(timeEntries).values([
              ...[
                {
                  userId: secondUserId,
                  dateWorked: "2020-01-18",
                  durationMinutes: 60,
                  status: "draft" as const,
                },
                {
                  userId: fixture.userId,
                  dateWorked: "2020-01-18",
                  durationMinutes: 15,
                  status: "submitted" as const,
                },
                {
                  userId: secondUserId,
                  dateWorked: "2019-12-15",
                  durationMinutes: 30,
                  status: "submitted" as const,
                },
              ].map((entry) => ({
                id: createSafeId<"timeEntry">(),
                organizationId: fixture.organizationId,
                workspaceId: secondMatterId,
                approverUserId: fixture.userId,
                timezoneId: "UTC",
                billedMinutes: entry.durationMinutes,
                rateAtEntry: cents(1000),
                currency: "EUR",
                narrative: "Second group work",
                ...entry,
              })),
              {
                id: createSafeId<"timeEntry">(),
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                userId: fixture.userId,
                approverUserId: fixture.userId,
                dateWorked: "2019-12-31",
                timezoneId: "UTC",
                durationMinutes: 45,
                billedMinutes: 45,
                rateAtEntry: cents(1000),
                currency: "USD",
                narrative: "Previous work",
                status: "approved",
              },
              ...["USD", "EUR"].map((currency) => ({
                id: createSafeId<"timeEntry">(),
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                userId: fixture.userId,
                approverUserId: fixture.userId,
                dateWorked: "2020-01-16",
                timezoneId: "UTC",
                durationMinutes: 10,
                billedMinutes: 1,
                rateAtEntry: cents(1000),
                currency,
                narrative: "Approved work",
                status: "approved" as const,
              })),
              {
                id: createSafeId<"timeEntry">(),
                organizationId: fixture.organizationId,
                workspaceId: fixture.workspaceId,
                userId: fixture.userId,
                approverUserId: fixture.userId,
                dateWorked: "2020-01-17",
                timezoneId: "UTC",
                durationMinutes: 20,
                billedMinutes: 20,
                rateAtEntry: cents(1000),
                currency: "USD",
                narrative: "No charge",
                noCharge: true,
                status: "approved",
              },
            ]);
            const member = await read(reportFixture);
            expect(
              member.rows
                .filter((row) => row.parentId === null)
                .reduce((sum, row) => sum + row.minutes, 0),
            ).toBe(415);
            expect(
              member.rows
                .filter((row) => row.parentId !== null)
                .reduce((sum, row) => sum + row.minutes, 0),
            ).toBe(415);
            expect(member.summary.current).toMatchObject({
              recordedMinutes: 415,
              billableMinutes: 395,
              pendingEntries: 12,
              activeMembers: 2,
            });
            expect(member.summary.current.unbilledValues).toEqual(
              expect.arrayContaining([
                { currency: "USD", value: 17 },
                { currency: "EUR", value: 17 },
              ]),
            );
            expect(member.summary.current.unbilledValues).toHaveLength(2);
            expect(member.summary.previous).toEqual({
              recordedMinutes: 75,
              billableMinutes: 75,
              pendingEntries: 1,
              activeMembers: 2,
              unbilledValues: [{ currency: "USD", value: 750 }],
            });
            const groupedMembers = await read(reportFixture, {
              bucket: "month",
            });
            expect(
              groupedMembers.rows
                .filter((row) => row.parentId === null)
                .map(({ rowId, minutes }) => ({ rowId, minutes })),
            ).toEqual(
              expect.arrayContaining([
                { rowId: fixture.userId, minutes: 355 },
                { rowId: secondUserId, minutes: 60 },
              ]),
            );
            expect(
              groupedMembers.rows.filter((row) => row.parentId === null),
            ).toHaveLength(2);
            expect(
              groupedMembers.rows
                .filter((row) => row.parentId !== null)
                .map(({ parentId, matterId, minutes }) => ({
                  parentId,
                  matterId,
                  minutes,
                })),
            ).toEqual(
              expect.arrayContaining([
                {
                  parentId: fixture.userId,
                  matterId: fixture.workspaceId,
                  minutes: 340,
                },
                {
                  parentId: fixture.userId,
                  matterId: secondMatterId,
                  minutes: 15,
                },
                {
                  parentId: secondUserId,
                  matterId: secondMatterId,
                  minutes: 60,
                },
              ]),
            );
            expect(
              groupedMembers.rows.filter((row) => row.parentId !== null),
            ).toHaveLength(3);
            for (const groupBy of ["matter", "client"] as const) {
              const response = await read(reportFixture, {
                groupBy,
                bucket: "month",
              });
              expect(
                response.rows.map(({ rowId, minutes }) => ({ rowId, minutes })),
              ).toEqual(
                expect.arrayContaining([
                  {
                    rowId:
                      groupBy === "matter"
                        ? fixture.workspaceId
                        : fixture.clientId,
                    minutes: 340,
                  },
                  {
                    rowId:
                      groupBy === "matter" ? secondMatterId : secondClientId,
                    minutes: 75,
                  },
                ]),
              );
              expect(response.rows).toHaveLength(2);
              expect(
                response.rows.reduce((sum, row) => sum + row.minutes, 0),
              ).toBe(415);
              expect(response.rows.every((row) => row.parentId === null)).toBe(
                true,
              );
            }
            expect(
              (await read(reportFixture, {}, "member")).summary.current
                .unbilledValues,
            ).toBeNull();
            for (const bucket of ["week", "month"] as const) {
              expect((await read(reportFixture, { bucket })).summary).toEqual(
                member.summary,
              );
            }
          } finally {
            await fixture.cleanup();
            await fixture.db
              .delete(authUser)
              .where(eq(authUser.id, secondUserId));
          }
        },
      );
    }, 120_000); // timeout: exercises grouping and billing projection against real PostgreSQL
  },
);
