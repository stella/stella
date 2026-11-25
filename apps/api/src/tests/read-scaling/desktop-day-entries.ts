import { panic, Result } from "better-result";
import { eq } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import { timeEntries, workspaceMembers, workspaces } from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import readDesktopDayEntries, {
  createDesktopDayEntriesEndpoint,
} from "@/api/handlers/desktop-time-entries/day-entries";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { cents } from "@/api/lib/money";
import {
  type AuthorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { deleteOrganizationsForTest } from "@/api/tests/helpers/organization-deletion";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const ROUTE = "/v1/desktop/day-entries" satisfies ApiRoutePath;
/** The work date every measured read asks for. */
export const DAY_ENTRIES_DATE = "2020-01-15";
/** The member's entries on {@link DAY_ENTRIES_DATE}: the fixed response. */
const ENTRIES_ON_DATE = 10;

/**
 * One member's matter with `size` of their entries: ten on the measured date,
 * the rest on earlier dates, so the population grows while the response
 * stays fixed.
 */
export const seedDesktopDayEntriesScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const createdAt = new Date("2020-01-01T00:00:00Z");
  await db.insert(organization).values({
    id: organizationId,
    name: "Desktop day entries fixture",
    slug: organizationId,
    createdAt,
  });
  await db.insert(user).values({
    id: userId,
    name: "Day entries member",
    email: `${userId}@example.test`,
    emailVerified: true,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "member",
    createdAt,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Day entries matter",
    reference: workspaceId,
  });
  await db.insert(workspaceMembers).values({ workspaceId, userId });
  const entryIds = Array.from({ length: size }, () =>
    createSafeId<"timeEntry">(),
  );
  await db.insert(timeEntries).values(
    entryIds.map((id, index) => ({
      id,
      organizationId,
      workspaceId,
      userId,
      dateWorked: index < ENTRIES_ON_DATE ? DAY_ENTRIES_DATE : "2019-06-15",
      timezoneId: "Europe/Prague",
      durationMinutes: 30,
      billedMinutes: 30,
      rateAtEntry: cents(1000),
      currency: "EUR",
      narrative: "Day entries work",
    })),
  );
  return {
    db,
    organizationId,
    userId,
    workspaceId,
    entryIdsOnDate: entryIds.slice(0, ENTRIES_ON_DATE),
    cleanup: async () => {
      await deleteOrganizationsForTest(db, [organizationId]);
      await db.delete(user).where(eq(user.id, userId));
    },
  };
};

export type DesktopDayEntriesFixture = Awaited<
  ReturnType<typeof seedDesktopDayEntriesScaling>
>;

type ReadDayEntriesOptions = {
  date: string;
  /** The member's role; a plain member by default. */
  memberRole?: AuthorizedMemberRole;
};

/**
 * Reads the fixture member's entries through the endpoint, with a fixture
 * device credential as its only collaborator; policy and SQL stay real. The
 * caller grants the activity timeline to the fixture's organization.
 */
export const readFixtureDayEntries = async (
  fixture: DesktopDayEntriesFixture,
  { date, memberRole = sessionMemberRole("member") }: ReadDayEntriesOptions,
) => {
  const request = new Request(`https://example.test${ROUTE}?date=${date}`);
  const device = await createDesktopDeviceSigner();
  const credential = "desktop-day-entries";
  const consumedProof = await claimFixtureDeviceProof({
    request: await device.signRequest({ request, credential }),
    deviceJkt: device.deviceJkt,
    keyId: credential,
    credential,
  });
  const account = {
    featureAccessSnapshot: buildFeatureAccessSnapshot({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      identity: {
        email: `${fixture.userId}@example.test`,
        emailVerified: true,
      },
      enrolments: [
        {
          featureId: "time-billing",
          organizationId: fixture.organizationId,
          userId: fixture.userId,
        },
      ],
    }),
    consumedProof,
    organizationId: fixture.organizationId,
    userId: fixture.userId,
    keyId: credential,
    memberRole,
    scopedDb: createMembershipScopedDb(markRlsDatabase(fixture.db), {
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      serverValidatedWorkspaceIds: [],
    }),
  };
  const endpoint = createDesktopDayEntriesEndpoint(
    async () => await Promise.resolve(Result.ok(account)),
  );
  return await endpoint.handler(
    asTestRaw<Parameters<typeof endpoint.handler>[0]>({
      request,
      route: ROUTE,
      query: { date },
      set: { headers: {} },
    }),
  );
};

export const desktopDayEntriesScalingScenario = {
  name: "desktop day entries",
  definition: readDesktopDayEntries,
  measure: async (fixture: DesktopDayEntriesFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await readFixtureDayEntries(fixture, {
        date: DAY_ENTRIES_DATE,
      });
      if (response instanceof HttpStatusResponse) {
        return panic("Desktop day entries scaling requires a response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.entries.length,
      };
    }),
};
