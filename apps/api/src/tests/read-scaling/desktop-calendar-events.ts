import { panic, Result } from "better-result";
import { inArray } from "drizzle-orm";

import type { DesktopCalendarEvent } from "@stll/api-contract/desktop-time-entries";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  ORGANIZATION_ACCESS_STATE,
  organizationAccessStates,
  organizationSettings,
  sharepointConnections,
} from "@/api/db/schema";
import { createMembershipScopedDb, markRlsDatabase } from "@/api/db/scoped";
import calendarEvents, {
  createDesktopCalendarEventsEndpoint,
} from "@/api/handlers/desktop-time-entries/calendar-events";
import type { ApiRoutePath } from "@/api/http/api-route-types";
import { HttpStatusResponse } from "@/api/http/status";
import { encryptSharepointSecret } from "@/api/lib/auth/microsoft365/crypto";
import { ensureSharepointAccessToken } from "@/api/lib/auth/microsoft365/graph-token";
import { createSafeId } from "@/api/lib/branded-types";
import { runWithMeasuredQueryCounter } from "@/api/lib/db-query-counter";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
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

const ROUTE = "/v1/desktop/calendar-events" satisfies ApiRoutePath;
const QUERY = { date: "2026-10-02", timeZone: "Europe/Prague" } as const;
const KEY_ID = "desktop-calendar-scaling";
const HOUR_MS = 3_600_000;

/** The fixed day the Graph stub answers, whatever the population. */
export const DESKTOP_CALENDAR_SCALING_EVENTS = [
  {
    timing: "timed",
    title: "Porada ke spisu",
    start: "2026-10-02T07:00:00Z",
    end: "2026-10-02T08:00:00Z",
    response: "accepted",
  },
  { timing: "allDay", title: "Jednání u soudu", response: "organizer" },
] as const satisfies readonly DesktopCalendarEvent[];

/**
 * A member's calendar connection among `size` colleagues' connections in the
 * same organization and `size` other organizations where the same member's
 * connection must be renewed and the calendar policy is off. Decoys go in
 * first, so a lookup that dropped its organization or member predicate would
 * answer another row rather than pass by insertion order.
 */
export const seedDesktopCalendarEventsScaling = async (
  db: GatedTestDb,
  size: number,
) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const colleagueIds = Array.from({ length: size }, () =>
    mintAuthProviderId<"user">(),
  );
  const otherOrganizationIds = Array.from({ length: size }, () =>
    mintAuthProviderId<"organization">(),
  );
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + HOUR_MS);
  await db.insert(organization).values(
    [...otherOrganizationIds, organizationId].map((id) => ({
      id,
      name: "Desktop calendar fixture",
      slug: id,
      createdAt,
    })),
  );
  await db.insert(organizationSettings).values([
    ...otherOrganizationIds.map((id) => ({
      organizationId: id,
      microsoft365CalendarReadEnabled: false,
    })),
    { organizationId, microsoft365CalendarReadEnabled: true },
  ]);
  // Member capacity needs the organization's access state before a second
  // member joins, as tests that add colleagues do.
  await db.insert(organizationAccessStates).values({
    organizationId,
    state: ORGANIZATION_ACCESS_STATE.selfManagedKeys,
  });
  await db.insert(user).values(
    [...colleagueIds, userId].map((id) => ({
      id,
      name: "Desktop calendar member",
      email: `${id}@fixture.test`,
      emailVerified: true,
    })),
  );
  await db.insert(member).values(
    [...colleagueIds, userId].map((id) => ({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: id,
      role: "member",
      createdAt,
    })),
  );
  const encrypted = await encryptSharepointSecret({
    organizationId,
    userId,
    purpose: "sharepoint_access_token",
    secret: "desktop-calendar-scaling-token",
  });
  await db.insert(sharepointConnections).values([
    ...otherOrganizationIds.map((id) => ({
      id: createSafeId<"sharepointConnection">(),
      organizationId: id,
      userId,
      accessTokenEncrypted: Buffer.alloc(32),
      accessTokenIv: Buffer.alloc(12),
      status: "reconnect_required" as const,
      scope: "Calendars.Read",
    })),
    ...colleagueIds.map((id) => ({
      id: createSafeId<"sharepointConnection">(),
      organizationId,
      userId: id,
      accessTokenEncrypted: Buffer.alloc(32),
      accessTokenIv: Buffer.alloc(12),
      status: "connected" as const,
      scope: "Calendars.Read",
      expiresAt,
    })),
    {
      id: createSafeId<"sharepointConnection">(),
      organizationId,
      userId,
      accessTokenEncrypted: encrypted.ciphertext,
      accessTokenIv: encrypted.iv,
      status: "connected" as const,
      scope: "Calendars.Read",
      expiresAt,
    },
  ]);
  return {
    organizationId,
    userId,
    scopedDb: createMembershipScopedDb(markRlsDatabase(db), {
      organizationId,
      userId,
      serverValidatedWorkspaceIds: [],
    }),
    cleanup: async () => {
      await deleteOrganizationsForTest(db, [
        organizationId,
        ...otherOrganizationIds,
      ]);
      await db.delete(user).where(inArray(user.id, [userId, ...colleagueIds]));
    },
  };
};

type DesktopCalendarEventsFixture = Awaited<
  ReturnType<typeof seedDesktopCalendarEventsScaling>
>;

/**
 * Reading one day of a linked desktop's calendar looks up the organization's
 * policy and the member's own connection, then admits its stored token under
 * the policy and connection locks. The device credential and the outbound
 * Graph read are the only collaborators supplied; the token owner and every
 * statement stay real.
 */
export const desktopCalendarEventsScalingScenario = {
  name: "desktop calendar events",
  definition: calendarEvents,
  measure: async (fixture: DesktopCalendarEventsFixture) => {
    const request = new Request(
      `https://example.test${ROUTE}?date=${QUERY.date}&timeZone=${encodeURIComponent(QUERY.timeZone)}`,
    );
    const device = await createDesktopDeviceSigner();
    const consumedProof = await claimFixtureDeviceProof({
      request: await device.signRequest({ request, credential: KEY_ID }),
      deviceJkt: device.deviceJkt,
      keyId: KEY_ID,
      credential: KEY_ID,
    });
    const graphReads: { start: string; end: string }[] = [];
    const endpoint = createDesktopCalendarEventsEndpoint({
      authorizeAccount: async () =>
        await Promise.resolve(
          Result.ok({
            featureAccessSnapshot: buildFeatureAccessSnapshot({
              organizationId: fixture.organizationId,
              userId: fixture.userId,
              identity: {
                email: `${fixture.userId}@fixture.test`,
                emailVerified: true,
              },
              enrolments: [
                {
                  featureId: "time-billing",
                  organizationId: fixture.organizationId,
                  userId: fixture.userId,
                },
              ],
              grants: {
                "activity-timeline": [
                  {
                    type: "organization",
                    organizationId: fixture.organizationId,
                  },
                ],
              },
            }),
            consumedProof,
            organizationId: fixture.organizationId,
            userId: fixture.userId,
            keyId: KEY_ID,
            memberRole: sessionMemberRole("member"),
            scopedDb: fixture.scopedDb,
          }),
        ),
      deploymentEnabled: isDeploymentFeatureEnabled,
      ensureAccessToken: ensureSharepointAccessToken,
      listDayReviewEvents: async (range) => {
        graphReads.push(range);
        return await Promise.resolve(
          Result.ok({
            events: [...DESKTOP_CALENDAR_SCALING_EVENTS],
            truncated: false,
          }),
        );
      },
    });
    return await runWithMeasuredQueryCounter(async (counter) => {
      const response = await endpoint.handler(
        asTestRaw<Parameters<typeof endpoint.handler>[0]>({
          request,
          query: QUERY,
          route: ROUTE,
          set: { headers: {} },
        }),
      );
      if (
        response instanceof HttpStatusResponse ||
        response.status !== "ready"
      ) {
        return panic(
          "Desktop calendar scaling requires the member's connected calendar",
        );
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.events.length,
        response,
        graphReads,
      };
    });
  },
};
