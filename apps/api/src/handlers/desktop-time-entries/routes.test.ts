import { Result } from "better-result";
import { expect, test } from "bun:test";

import { createTestState } from "@stll/test-state";

import { timeEntries } from "@/api/db/schema";
import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { RouteEntry } from "@/api/http/route";
import { DEFAULT_TIME_POLICY } from "@/api/lib/billing-time";
import { toSafeId } from "@/api/lib/branded-types";
import { buildFeatureAccessSnapshot } from "@/api/lib/feature-access/snapshot";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import {
  claimFixtureDeviceProof,
  createDesktopDeviceSigner,
} from "@/api/tests/helpers/desktop-device-proof";
import { serveForTest } from "@/api/tests/helpers/test-server";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDesktopMatterCandidatesEndpoint } from "./candidates";
import { createDesktopTimeEntryEndpoint } from "./create";
import { createDesktopMattersEndpoint } from "./matters";
import { createDesktopMatterResolveEndpoint } from "./resolve";
import { desktopTimeEntriesRoute } from "./routes";

const testState = createTestState({ file: import.meta.path, config: env });
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_test";
const USER_ID = "user_test";
const serve = (table: readonly RouteEntry[]) =>
  serveForTest(createHttpApp({ routes: table, middleware: [errorBoundary] }));

const BODY = {
  dateWorked: new Date().toISOString().slice(0, 10),
  timezoneId: "UTC",
  durationMinutes: 30,
  narrative: "Confirmed work",
  billable: false,
};

test("desktop time entry endpoints require desktop account credentials", async () => {
  await using server = serve(desktopTimeEntriesRoute);
  for (const path of [
    "matters",
    "matter-candidates",
    `matter-candidates/resolve?id=${WORKSPACE_ID}`,
    "calendar-events?date=2026-10-02&timeZone=Europe%2FPrague",
    `time-entries/${WORKSPACE_ID}`,
    "time-entries/batch",
    "time-entries/batch/status",
  ]) {
    let body = JSON.stringify(BODY);
    if (path === "time-entries/batch/status") {
      body = JSON.stringify({ idempotencyKey: "test" });
    } else if (path === "time-entries/batch") {
      body = JSON.stringify({
        idempotencyKey: "test",
        entries: [{ matterId: WORKSPACE_ID, ...BODY }],
      });
    }
    const response = await server.fetch(
      new Request(
        `http://localhost/v1/desktop/${path}`,
        path.startsWith("time-entries/")
          ? {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body,
            }
          : {},
      ),
    );
    expect(response.status).toBe(401);
  }
});

const exercise = async ({
  hidden,
  denied,
  extra,
  missingMatter,
  picker,
  candidates,
  resolve,
  emailVerified = true,
  color = "--option-emerald",
}: {
  hidden?: "activity-timeline" | "time-billing";
  /** Every member whose email is verified has the dictation decision. */
  emailVerified?: boolean;
  denied?: boolean;
  extra?: Record<string, unknown>;
  missingMatter?: boolean;
  picker?: boolean;
  candidates?: boolean;
  /** Matter ids the desktop resolves; the database holds only `WORKSPACE_ID`. */
  resolve?: readonly string[];
  color?: string | null;
}) => {
  const inserted: unknown[] = [];
  const candidateRow = {
    id: WORKSPACE_ID,
    name: "Matter",
    reference: "M-1",
    color,
    clientName: "Client",
    lastWorkedAt: "2026-10-08",
    newlyAssignedAt: null,
    upcomingDeadline: "2026-10-12",
  };
  const { scopedDb } = createScopedDbMock(
    {
      query: {
        workspaces: {
          findFirst: async () =>
            missingMatter ? undefined : { id: WORKSPACE_ID, leadUserId: null },
          findMany: async () => [
            {
              id: WORKSPACE_ID,
              name: "Matter",
              reference: "M-1",
              color,
              clientId: null,
            },
          ],
        },
        organizationSettings: { findFirst: async () => DEFAULT_TIME_POLICY },
        rateTables: { findMany: async () => [] },
      },
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              orderBy: () => ({ limit: async () => [candidateRow] }),
              limit: async () =>
                resolve?.some((id) => id.toLowerCase() === WORKSPACE_ID)
                  ? [candidateRow]
                  : [],
            }),
          }),
        }),
      }),
      execute: async () => {},
      $count: async () => 0,
      insert: (table: unknown) => ({
        values: (row: unknown) => {
          if (table === timeEntries) {
            inserted.push(row);
          }
          return {
            returning: async () => [
              { id: "00000000-0000-4000-8000-000000000002" },
            ],
          };
        },
      }),
    },
    {
      featureAccess: {
        identity: { email: "desktop@example.test", emailVerified },
        enrolments:
          hidden === "time-billing"
            ? []
            : [
                {
                  featureId: "time-billing",
                  organizationId: toSafeId<"organization">(ORGANIZATION_ID),
                  userId: USER_ID,
                },
              ],
      },
    },
  );
  const device = await createDesktopDeviceSigner();
  const authorizeAccount = async (request: Request) =>
    Result.ok({
      featureAccessSnapshot: buildFeatureAccessSnapshot({
        organizationId: toSafeId<"organization">(ORGANIZATION_ID),
        userId: USER_ID,
        identity: { email: "desktop@example.test", emailVerified },
        enrolments:
          hidden === "time-billing"
            ? []
            : [
                {
                  featureId: "time-billing",
                  organizationId: ORGANIZATION_ID,
                  userId: USER_ID,
                },
              ],
      }),
      consumedProof: await claimFixtureDeviceProof({
        request: await device.signRequest({
          request,
          credential: "fixture-credential",
        }),
        deviceJkt: device.deviceJkt,
        keyId: "desktop-key",
        credential: "fixture-credential",
      }),
      scopedDb,
      organizationId: toSafeId<"organization">(ORGANIZATION_ID),
      userId: toSafeId<"user">(USER_ID),
      keyId: "desktop-key",
      memberRole: denied
        ? authorizedMemberRole({
            role: "member",
            credential: {
              type: "attenuated",
              permissions: { workspace: ["read"] },
            },
          })
        : sessionMemberRole("member"),
    });
  const create = createDesktopTimeEntryEndpoint(authorizeAccount);
  const matters = createDesktopMattersEndpoint(authorizeAccount);
  const candidateEndpoint =
    createDesktopMatterCandidatesEndpoint(authorizeAccount);
  const resolveEndpoint = createDesktopMatterResolveEndpoint(authorizeAccount);
  await using server = serve(
    routes(
      {
        "/matter-candidates": { GET: candidateEndpoint },
        "/matter-candidates/resolve": { GET: resolveEndpoint },
        "/time-entries/:workspaceId": { PUT: create },
        "/matters": { GET: matters },
      },
      { prefix: "/v1/desktop" },
    ),
  );
  testState.setConfig("FEATURE_TIME_BILLING", true);
  const member = {
    type: "member",
    organizationId: toSafeId<"organization">(ORGANIZATION_ID),
    email: "desktop@example.test",
  } as const;
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline": hidden === "activity-timeline" ? [] : [member],
  });
  let url = `http://localhost/v1/desktop/time-entries/${WORKSPACE_ID}`;
  if (picker) {
    url = "http://localhost/v1/desktop/matters?query=Matter";
  }
  if (candidates) {
    url = "http://localhost/v1/desktop/matter-candidates";
  }
  if (resolve) {
    const query = new URLSearchParams(
      resolve.map((id): [string, string] => ["id", id]),
    );
    url = `http://localhost/v1/desktop/matter-candidates/resolve?${query.toString()}`;
  }
  const response = await server.fetch(
    new Request(
      url,
      picker || candidates || resolve
        ? {}
        : {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...BODY, ...extra }),
          },
    ),
  );
  return { status: response.status, body: await response.json(), inserted };
};

test("either hidden feature refuses creation", async () => {
  for (const hidden of ["activity-timeline", "time-billing"] as const) {
    const result = await exercise({ hidden });
    expect(result.status).toBe(403);
    expect(result.inserted).toEqual([]);
  }
});

test("create permission and accessible matter are required", async () => {
  expect((await exercise({ denied: true })).status).toBe(403);
  const readablePicker = await exercise({ denied: true, picker: true });
  expect(readablePicker.status).toBe(200);
  expect(readablePicker.body).toEqual({
    matters: [
      {
        id: WORKSPACE_ID,
        name: "Matter",
        reference: "M-1",
        color: "--option-emerald",
      },
    ],
  });
  expect(readablePicker.inserted).toEqual([]);
  expect((await exercise({ missingMatter: true })).status).toBe(404);
});

test("confirmed entries use the insert owner with activity source and default draft status", async () => {
  const result = await exercise({});
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ id: "00000000-0000-4000-8000-000000000002" });
  expect(result.inserted).toHaveLength(1);
  expect(result.inserted.at(0)).toMatchObject({
    source: "activity",
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    narrative: BODY.narrative,
  });
  expect(result.inserted.at(0)).not.toHaveProperty("status");
  expect(timeEntries.status.default).toBe("draft");
});

test("unknown activity fields and other session-only fields are rejected", async () => {
  for (const extra of [
    { appName: "private" },
    { rawSegments: [] },
    { summary: "private" },
    { taskCode: "private" },
  ]) {
    const result = await exercise({ extra });
    expect(result.status).toBe(422);
    expect(result.inserted).toEqual([]);
  }
});

test("a member who dictates finds matters to file a recording under, without time entries", async () => {
  const filing = await exercise({ hidden: "activity-timeline", picker: true });
  expect(filing.status).toBe(200);
  expect(filing.body).toEqual({
    matters: [
      {
        id: WORKSPACE_ID,
        name: "Matter",
        reference: "M-1",
        color: "--option-emerald",
      },
    ],
  });
  // Without a verified email the caller has neither decision.
  expect((await exercise({ emailVerified: false, picker: true })).status).toBe(
    403,
  );
  // Dictation opens the search only: time entries still need their feature.
  expect((await exercise({ hidden: "activity-timeline" })).status).toBe(403);
  expect(
    (await exercise({ hidden: "activity-timeline", candidates: true })).status,
  ).toBe(403);
});

test("picker preserves stored and fallback matter colors in its display projection", async () => {
  for (const color of ["--option-emerald", "#A1B2C3", null]) {
    expect((await exercise({ picker: true, color })).body).toEqual({
      matters: [{ id: WORKSPACE_ID, name: "Matter", reference: "M-1", color }],
    });
  }
});

test("candidate endpoint preserves bounded caller-scoped matching signals and feature authorization", async () => {
  const result = await exercise({ candidates: true });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    matters: [
      {
        id: WORKSPACE_ID,
        name: "Matter",
        reference: "M-1",
        color: "--option-emerald",
        clientName: "Client",
        signals: {
          lastWorkedAt: "2026-10-08",
          newlyAssignedAt: null,
          upcomingDeadline: "2026-10-12",
        },
      },
    ],
    timeMinimumUnitMinutes: DEFAULT_TIME_POLICY.timeMinimumUnitMinutes,
  });
  expect(result.inserted).toEqual([]);
  for (const hidden of ["activity-timeline", "time-billing"] as const) {
    expect((await exercise({ candidates: true, hidden })).status).toBe(403);
  }
});

test("resolving names only matters the caller can open, each once, in the order asked", async () => {
  const other = "00000000-0000-4000-8000-0000000000ff";
  const result = await exercise({
    resolve: [other, WORKSPACE_ID.toUpperCase()],
  });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    matters: [
      { type: "inaccessible", id: other },
      {
        type: "accessible",
        matter: {
          id: WORKSPACE_ID,
          name: "Matter",
          reference: "M-1",
          color: "--option-emerald",
          clientName: "Client",
          signals: {
            lastWorkedAt: "2026-10-08",
            newlyAssignedAt: null,
            upcomingDeadline: "2026-10-12",
          },
        },
      },
    ],
  });
  expect((await exercise({ resolve: [other] })).body).toEqual({
    matters: [{ type: "inaccessible", id: other }],
  });
  for (const hidden of ["activity-timeline", "time-billing"] as const) {
    expect((await exercise({ resolve: [WORKSPACE_ID], hidden })).status).toBe(
      403,
    );
  }
});

test("resolving refuses ids that are not one bounded list of distinct matter ids", async () => {
  const many = Array.from(
    { length: 101 },
    (_, index) =>
      `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
  );
  for (const resolve of [
    [],
    ["not-a-matter"],
    [WORKSPACE_ID, WORKSPACE_ID],
    many,
  ]) {
    expect((await exercise({ resolve })).status).toBe(422);
  }
});
