import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import { compareCodeUnit } from "@stll/collation";
import { createTestState } from "@stll/test-state";

import { member, user } from "@/api/db/auth-schema";
import { timeEntries, workspaceMembers } from "@/api/db/schema";
import { env } from "@/api/env";
import { HttpStatusResponse } from "@/api/http/status";
import { UNPRICED_TIME_ENTRY_CURRENCY } from "@/api/lib/billing-constants";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { authorizedMemberRole } from "@/api/lib/permission-authorization";
import { apiApp } from "@/api/server";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  DAY_ENTRIES_DATE,
  type DesktopDayEntriesFixture,
  desktopDayEntriesScalingScenario,
  readFixtureDayEntries,
  seedDesktopDayEntriesScaling,
} from "@/api/tests/read-scaling/desktop-day-entries";
import { readScalingViolations } from "@/api/tests/read-scaling/measurement";

const testState = createTestState({ file: import.meta.path, config: env });

const grantActivityTimeline = (fixture: DesktopDayEntriesFixture) => {
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": [
      { type: "organization", organizationId: fixture.organizationId },
    ],
  });
};

const entryRow = (
  fixture: DesktopDayEntriesFixture,
  row: {
    userId?: string;
    dateWorked: string;
    timezoneId: string;
    createdAt: Date;
    durationMinutes: number;
  },
) => {
  const id = createSafeId<"timeEntry">();
  return {
    id,
    organizationId: fixture.organizationId,
    workspaceId: fixture.workspaceId,
    activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
    userId: row.userId ?? fixture.userId,
    dateWorked: row.dateWorked,
    timezoneId: row.timezoneId,
    durationMinutes: row.durationMinutes,
    billedMinutes: row.durationMinutes,
    rateAtEntry: cents(1000),
    currency: "EUR",
    narrative: "Day entries boundary",
    createdAt: row.createdAt,
  };
};

describe.skipIf(process.env["STELLA_RUN_POSTGRES_TESTS"] !== "true")(
  "desktop day entries",
  () => {
    test("returns only the member's own client entries on their own calendar date", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const fixture = await seedDesktopDayEntriesScaling(db, 12);
          const colleagueId = mintAuthProviderId<"user">();
          try {
            grantActivityTimeline(fixture);
            await db.insert(user).values({
              id: colleagueId,
              name: "Colleague",
              email: `${colleagueId}@example.test`,
              emailVerified: true,
            });
            await db.insert(member).values({
              id: mintAuthProviderIdValue(),
              organizationId: fixture.organizationId,
              userId: colleagueId,
              role: "member",
              createdAt: new Date("2020-01-01T00:00:00Z"),
            });
            await db.insert(workspaceMembers).values({
              workspaceId: fixture.workspaceId,
              userId: colleagueId,
            });
            // Auckland is UTC+13 in January. Worked at 01:00 on the 15th
            // there, recorded on the 14th in UTC: it belongs to the 15th.
            const earlyInZone = entryRow(fixture, {
              dateWorked: DAY_ENTRIES_DATE,
              timezoneId: "Pacific/Auckland",
              createdAt: new Date("2020-01-14T12:00:00Z"),
              durationMinutes: 45,
            });
            // Worked at 02:00 on the 16th there, recorded on the 15th in UTC:
            // it belongs to the 16th.
            const nextDayInZone = entryRow(fixture, {
              dateWorked: "2020-01-16",
              timezoneId: "Pacific/Auckland",
              createdAt: new Date("2020-01-15T13:00:00Z"),
              durationMinutes: 20,
            });
            const dayBefore = entryRow(fixture, {
              dateWorked: "2020-01-14",
              timezoneId: "Europe/Prague",
              createdAt: new Date("2020-01-14T22:30:00Z"),
              durationMinutes: 15,
            });
            const colleagues = entryRow(fixture, {
              userId: colleagueId,
              dateWorked: DAY_ENTRIES_DATE,
              timezoneId: "Europe/Prague",
              createdAt: new Date("2020-01-15T10:00:00Z"),
              durationMinutes: 90,
            });
            // Internal time has no matter and is never priced.
            const internal = {
              id: createSafeId<"timeEntry">(),
              organizationId: fixture.organizationId,
              workspaceId: null,
              activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
              userId: fixture.userId,
              dateWorked: DAY_ENTRIES_DATE,
              timezoneId: "Europe/Prague",
              durationMinutes: 30,
              billedMinutes: 0,
              rateAtEntry: cents(0),
              currency: UNPRICED_TIME_ENTRY_CURRENCY,
              billable: false,
              narrative: "Internal training",
            };
            await db
              .insert(timeEntries)
              .values([
                earlyInZone,
                nextDayInZone,
                dayBefore,
                colleagues,
                internal,
              ]);

            const response = await readFixtureDayEntries(fixture, {
              date: DAY_ENTRIES_DATE,
            });
            const entries =
              response instanceof HttpStatusResponse
                ? panic("Expected the member's day entries")
                : response.entries;
            expect(
              entries.toSorted((left, right) =>
                compareCodeUnit(left.id, right.id),
              ),
            ).toEqual(
              [
                ...fixture.entryIdsOnDate.map((id) => ({
                  id: String(id),
                  matterId: String(fixture.workspaceId),
                  durationMinutes: 30,
                })),
                {
                  id: String(earlyInZone.id),
                  matterId: String(fixture.workspaceId),
                  durationMinutes: 45,
                },
              ].toSorted((left, right) => compareCodeUnit(left.id, right.id)),
            );
            // Nothing about the time of day leaves the server.
            for (const entry of entries) {
              expect(Object.keys(entry).toSorted()).toEqual([
                "durationMinutes",
                "id",
                "matterId",
              ]);
            }
          } finally {
            await fixture.cleanup();
            await db.delete(user).where(eq(user.id, colleagueId));
          }
        },
      );
    }, 120_000); // timeout: seeds a member, a colleague and entries in real PostgreSQL

    test("refuses a credential without time entry read access", async () => {
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const fixture = await seedDesktopDayEntriesScaling(
            openClient({ max: 1 }).db,
            10,
          );
          try {
            grantActivityTimeline(fixture);
            const response = await readFixtureDayEntries(fixture, {
              date: DAY_ENTRIES_DATE,
              memberRole: authorizedMemberRole({
                role: "member",
                credential: {
                  type: "attenuated",
                  permissions: { workspace: ["read"] },
                },
              }),
            });
            expect(response).toBeInstanceOf(HttpStatusResponse);
            if (response instanceof HttpStatusResponse) {
              expect(response.code).toBe(403);
            }
          } finally {
            await fixture.cleanup();
          }
        },
      );
    }, 120_000); // timeout: seeds a member and entries in real PostgreSQL

    test("reads a fixed day with the same round trips as the member's history grows", async () => {
      expect(
        apiApp.routes.some(
          ({ definition }) =>
            definition === desktopDayEntriesScalingScenario.definition,
        ),
      ).toBe(true);
      await withGatedTestClients(
        process.env["DATABASE_URL"] ?? panic("DATABASE_URL required"),
        async ({ openClient }) => {
          const { db } = openClient({ max: 1 });
          const measureAt = async (size: number) => {
            const fixture = await seedDesktopDayEntriesScaling(db, size);
            try {
              grantActivityTimeline(fixture);
              return await desktopDayEntriesScalingScenario.measure(fixture);
            } finally {
              await fixture.cleanup();
            }
          };
          const small = await measureAt(10);
          const large = await measureAt(200);
          expect(small.rows).toBe(10);
          expect(large.rows).toBe(10);
          expect(readScalingViolations({ small, large })).toEqual([]);
        },
      );
    }, 120_000); // timeout: seeds two populations in real PostgreSQL
  },
);
