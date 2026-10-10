import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  entities,
  entityVersions,
  fields,
  properties,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  NO_AUDIT,
  NO_DB,
  createTestHandlerContext,
} from "@/api/tests/helpers/handler-context";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { toSafeDbMock } from "@/api/tests/scoped-db-mock";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

import calendarTasks from "./list";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const workspaceId = createSafeId<"workspace">();
const customStart = createSafeId<"property">();
const customEnd = createSafeId<"property">();
const early = "2026-10-02T23:59:59.999Z";
const late = "2026-10-03T00:00:00.001Z";
const oldDate = new Date("2026-01-01T00:00:00Z");

type CalendarSuiteDatabase = {
  label: "pglite" | "postgres";
  // Called while the suite is being declared, so lifecycle hooks register on it.
  connect: () => {
    open: () => Promise<TestDatabase>;
    cleanUp: (step: () => Promise<void>) => void;
  };
};

// The same fixtures and assertions run on PGlite in every test run and on a
// real Postgres server in the gated Postgres job.
const defineCalendarRangeSuite = ({ label, connect }: CalendarSuiteDatabase) =>
  describe(`calendar UTC-day ranges (${label})`, () => {
    const { open, cleanUp } = connect();
    let testDb: TestDatabase;
    let safeDb: SafeDb;
    const expectedByProperty = new Map<string, string[]>();
    const spanIds = new Map<string, string>();

    type SeedTaskOptions = {
      name: string;
      createdAt?: Date;
      updatedAt?: Date;
      startAt?: Date;
      occurredAt?: Date;
      dueDate?: string;
      customStartDate?: string;
      customEndDate?: string;
    };

    const seedTask = async ({
      name,
      customStartDate,
      customEndDate,
      ...dates
    }: SeedTaskOptions) => {
      const id = createSafeId<"entity">();
      await testDb.insert(entities).values({
        id,
        workspaceId,
        kind: "task",
        name,
        createdAt: oldDate,
        updatedAt: oldDate,
        ...dates,
      });
      const cells = [
        { propertyId: customStart, value: customStartDate },
        { propertyId: customEnd, value: customEndDate },
      ].filter((cell) => cell.value !== undefined);
      if (cells.length === 0) {
        return id;
      }
      const versionId = createSafeId<"entityVersion">();
      await testDb.insert(entityVersions).values({
        id: versionId,
        workspaceId,
        entityId: id,
      });
      await testDb
        .update(entities)
        .set({ currentVersionId: versionId })
        .where(eq(entities.id, id));
      await testDb.insert(fields).values(
        cells.map(({ propertyId, value }) => ({
          id: createSafeId<"field">(),
          workspaceId,
          entityVersionId: versionId,
          propertyId,
          content: {
            type: "date" as const,
            version: 1 as const,
            value: value ?? null,
          },
        })),
      );
      return id;
    };

    const cleanup = async () => {
      await testDb
        .update(entities)
        .set({ currentVersionId: null })
        .where(eq(entities.workspaceId, workspaceId));
      await testDb
        .delete(organization)
        .where(eq(organization.id, organizationId));
      await testDb.delete(user).where(eq(user.id, userId));
    };

    beforeAll(async () => {
      testDb = await open();
      await testDb.execute(sql`SET TIME ZONE 'UTC'`);
      await testDb.insert(user).values({
        id: userId,
        name: "Calendar fixture",
        email: `${userId}@example.test`,
      });
      await testDb.insert(organization).values({
        id: organizationId,
        name: "Calendar fixture",
        slug: organizationId,
        createdAt: oldDate,
      });
      await testDb.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId,
        userId,
        role: "owner",
        createdAt: oldDate,
      });
      await testDb.insert(workspaces).values({
        id: workspaceId,
        organizationId,
        name: "Calendar fixture",
        reference: workspaceId,
      });
      await testDb.insert(workspaceMembers).values({ workspaceId, userId });
      await testDb.insert(properties).values(
        [customStart, customEnd].map((id) => ({
          id,
          workspaceId,
          name: "Calendar date",
          status: "fresh" as const,
          content: { type: "date" as const, version: 1 as const },
          tool: { type: "manual-input" as const, version: 1 as const },
        })),
      );
      safeDb = toSafeDbMock(
        asTestRaw<ScopedDb>(
          createScopedDb(testDb, [workspaceId], organizationId, userId),
        ),
      );
      const created = await seedTask({
        name: "Created before midnight",
        createdAt: new Date(early),
      });
      await seedTask({
        name: "Created after midnight",
        createdAt: new Date(late),
      });
      const updated = await seedTask({
        name: "Updated before midnight",
        updatedAt: new Date(early),
      });
      await seedTask({
        name: "Updated after midnight",
        updatedAt: new Date(late),
      });
      const start = await seedTask({
        name: "Starts before midnight",
        startAt: new Date(early),
      });
      await seedTask({
        name: "Starts after midnight",
        startAt: new Date(late),
      });
      const occurred = await seedTask({
        name: "Occurs before midnight",
        occurredAt: new Date(early),
      });
      await seedTask({
        name: "Occurs after midnight",
        occurredAt: new Date(late),
      });
      await seedTask({
        name: "Start takes precedence over occurrence",
        startAt: new Date(late),
        occurredAt: new Date(early),
      });
      const due = await seedTask({
        name: "Due on first day",
        dueDate: "2026-10-02",
      });
      await seedTask({ name: "Due on next day", dueDate: "2026-10-03" });
      const custom = await seedTask({
        name: "Custom first day",
        customStartDate: "2026-10-02",
      });
      await seedTask({
        name: "Custom next day",
        customStartDate: "2026-10-03",
      });
      expectedByProperty.set("_created-at", [created]);
      expectedByProperty.set("_updated-at", [updated]);
      expectedByProperty.set("_start-date", [start, occurred, due].toSorted());
      expectedByProperty.set("_due-date", [due]);
      expectedByProperty.set(customStart, [custom]);
      spanIds.set(
        "built-in",
        await seedTask({
          name: "Built-in span",
          startAt: new Date("2026-10-01T23:59:59.999Z"),
          dueDate: "2026-10-04",
        }),
      );
      spanIds.set(
        "custom",
        await seedTask({
          name: "Custom span",
          customStartDate: "2026-10-01",
          customEndDate: "2026-10-04",
        }),
      );
      spanIds.set(
        "mixed-start",
        await seedTask({
          name: "Built-in to custom span",
          startAt: new Date("2026-10-01T23:59:59.999Z"),
          customEndDate: "2026-10-04",
        }),
      );
      spanIds.set(
        "mixed-end",
        await seedTask({
          name: "Custom to built-in span",
          customStartDate: "2026-10-01",
          dueDate: "2026-10-04",
        }),
      );
      await seedTask({
        name: "Built-in span before window",
        startAt: new Date("2026-10-01T00:00:00Z"),
        dueDate: "2026-10-01",
      });
      await seedTask({
        name: "Built-in span after window",
        startAt: new Date("2026-10-03T00:00:00Z"),
        dueDate: "2026-10-04",
      });
      await seedTask({
        name: "Custom span before window",
        customStartDate: "2026-10-01",
        customEndDate: "2026-10-01",
      });
      await seedTask({
        name: "Custom span after window",
        customStartDate: "2026-10-03",
        customEndDate: "2026-10-04",
      });
    });

    cleanUp(cleanup);

    type CalendarBody = Parameters<typeof calendarTasks.handler>[0]["body"];
    const list = async (body: CalendarBody) =>
      await calendarTasks.handler(
        createTestHandlerContext<Parameters<typeof calendarTasks.handler>[0]>({
          audit: NO_AUDIT,
          scopedDb: NO_DB,
          workspaceId,
          session: { activeOrganizationId: organizationId },
          user: { id: userId },
          safeDb,
          body,
        }),
      );

    const outcome = async (body: CalendarBody) => {
      const result = await list(body);
      if ("tasks" in result) {
        return {
          type: "accepted" as const,
          ids: result.tasks.map(({ taskId }) => taskId).toSorted(),
        };
      }
      expect(result.code).toBe(400);
      return { type: "rejected" as const, code: result.code };
    };

    const dayBody = (propertyId: string): CalendarBody => ({
      dateFrom: "2026-10-02T00:00:00Z",
      dateTo: early,
      datePropertyIds: [propertyId],
    });

    const reencode = (milliseconds: number, offset: string) =>
      Temporal.Instant.fromEpochMilliseconds(milliseconds)
        .toZonedDateTimeISO(offset)
        .toString({ timeZoneName: "never", calendarName: "never" });

    test("projects every date source independently across UTC midnight and database timezones", async () => {
      const baseline = new Map<string, Awaited<ReturnType<typeof outcome>>>();
      for (const [propertyId, ids] of expectedByProperty) {
        const result = await outcome(dayBody(propertyId));
        expect(result).toEqual({ type: "accepted", ids });
        baseline.set(propertyId, result);
      }
      await testDb.execute(sql`SET TIME ZONE 'Pacific/Kiritimati'`);
      try {
        for (const [propertyId, expected] of baseline) {
          expect(await outcome(dayBody(propertyId))).toEqual(expected);
        }
      } finally {
        await testDb.execute(sql`SET TIME ZONE 'UTC'`);
      }
    });

    test("includes spanning tasks through built-in and custom date bounds", async () => {
      const cases = [
        { primary: "_start-date", end: "_due-date", span: "built-in" },
        { primary: customStart, end: customEnd, span: "custom" },
        { primary: "_start-date", end: customEnd, span: "mixed-start" },
        { primary: customStart, end: "_due-date", span: "mixed-end" },
      ];
      for (const timezone of ["UTC", "Pacific/Kiritimati"]) {
        await testDb.execute(
          sql`SELECT set_config('TimeZone', ${timezone}, false)`,
        );
        try {
          for (const { primary, end, span } of cases) {
            const expected = [
              ...(expectedByProperty.get(primary) ?? []),
              spanIds.get(span) ?? "missing span fixture",
            ].toSorted();
            expect(
              await outcome({ ...dayBody(primary), endDatePropertyId: end }),
            ).toEqual({ type: "accepted", ids: expected });
          }
        } finally {
          await testDb.execute(sql`SET TIME ZONE 'UTC'`);
        }
      }
    });

    test.each(["+14:00", "-12:00", "+05:45"])(
      "keeps both bound days when encoded at %s",
      async (offset) => {
        for (const propertyId of expectedByProperty.keys()) {
          const body = dayBody(propertyId);
          const expected = await outcome(body);
          expect(
            await outcome({
              ...body,
              dateFrom: reencode(Date.parse(body.dateFrom), offset),
            }),
          ).toEqual(expected);
          expect(
            await outcome({
              ...body,
              dateTo: reencode(Date.parse(body.dateTo), offset),
            }),
          ).toEqual(expected);
        }
      },
    );

    test("calendar-range-offset-invariance", async () => {
      const instant = fc.integer({
        min: Date.parse("2026-10-01T00:00:00Z"),
        max: Date.parse("2026-10-04T23:59:59.999Z"),
      });
      const offset = fc.oneof(
        fc.constantFrom("+14:00", "-12:00", "+05:45"),
        fc.integer({ min: -720, max: 840 }).map((minutes) => {
          const magnitude = Math.abs(minutes);
          return `${minutes < 0 ? "-" : "+"}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
        }),
      );
      await assertProperty(
        "calendar-range-offset-invariance",
        fc.asyncProperty(
          instant,
          instant,
          offset,
          offset,
          fc.constantFrom(
            ...[...expectedByProperty.keys()].map((propertyId) => ({
              datePropertyIds: [propertyId],
            })),
            {
              datePropertyIds: ["_start-date"],
              endDatePropertyId: "_due-date",
            },
            { datePropertyIds: [customStart], endDatePropertyId: customEnd },
            { datePropertyIds: ["_start-date"], endDatePropertyId: customEnd },
            { datePropertyIds: [customStart], endDatePropertyId: "_due-date" },
          ),
          async (from, to, fromOffset, toOffset, selection) => {
            const body = {
              dateFrom: reencode(from, "+00:00"),
              dateTo: reencode(to, "+00:00"),
              ...selection,
            };
            const expected = await outcome(body);
            expect(expected.type).toBe(from > to ? "rejected" : "accepted");
            expect(
              await outcome({ ...body, dateFrom: reencode(from, fromOffset) }),
            ).toEqual(expected);
            expect(
              await outcome({ ...body, dateTo: reencode(to, toOffset) }),
            ).toEqual(expected);
            expect(
              await outcome({
                ...body,
                dateFrom: reencode(from, fromOffset),
                dateTo: reencode(to, toOffset),
              }),
            ).toEqual(expected);
          },
        ),
        { numRuns: 30 },
      );
    });

    test("rejects reversed instants on the same UTC day", async () => {
      expect(
        await outcome({
          ...dayBody("_start-date"),
          dateFrom: "2026-10-02T23:00:00Z",
          dateTo: "2026-10-02T22:00:00Z",
        }),
      ).toEqual({ type: "rejected", code: 400 });
    });
  });

defineCalendarRangeSuite({
  label: "pglite",
  connect: () => ({
    open: getTestDb,
    cleanUp: (step) => {
      afterAll(async () => {
        try {
          await step();
        } finally {
          await releaseTestDb();
        }
      });
    },
  }),
});

if (!databaseUrl || !runPostgresTests) {
  describe.skip("calendar UTC-day ranges (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  defineCalendarRangeSuite({
    label: "postgres",
    connect: () => {
      const postgres = openGatedTestDatabase(databaseUrl, { max: 1 });
      return {
        open: async () => asTestRaw<TestDatabase>(markRlsDatabase(postgres.db)),
        cleanUp: postgres.cleanUp,
      };
    },
  });
}
