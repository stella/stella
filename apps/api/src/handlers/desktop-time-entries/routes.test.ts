import { Result } from "better-result";
import { expect, test } from "bun:test";
import Elysia from "elysia";

import { timeEntries } from "@/api/db/schema";
import { env } from "@/api/env";
import { DEFAULT_TIME_POLICY } from "@/api/lib/billing-time";
import { toSafeId } from "@/api/lib/branded-types";
import {
  authorizedMemberRole,
  sessionMemberRole,
} from "@/api/lib/permission-authorization";
import { createTestState } from "@/api/tests/helpers/test-state";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDesktopMatterCandidatesEndpoint } from "./candidates";
import { createDesktopTimeEntryEndpoint } from "./create";
import { createDesktopMattersEndpoint } from "./matters";
import { desktopTimeEntriesRoute } from "./routes";

const testState = createTestState({ file: import.meta.path, config: env });
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "org_test";
const USER_ID = "user_test";
const BODY = {
  dateWorked: new Date().toISOString().slice(0, 10),
  timezoneId: "UTC",
  durationMinutes: 30,
  narrative: "Confirmed work",
  billable: false,
};

test("desktop time entry endpoints require desktop account credentials", async () => {
  const app = new Elysia().use(desktopTimeEntriesRoute);
  for (const path of [
    "matters",
    "matter-candidates",
    `time-entries/${WORKSPACE_ID}`,
    "time-entries/batch",
  ]) {
    const response = await app.handle(
      new Request(
        `http://localhost/v1/desktop/${path}`,
        !["time-entries/batch", `time-entries/${WORKSPACE_ID}`].includes(path)
          ? {}
          : {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(
                path === "time-entries/batch"
                  ? {
                      idempotencyKey: "test",
                      entries: [{ matterId: WORKSPACE_ID, ...BODY }],
                    }
                  : BODY,
              ),
            },
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
  color = "--option-emerald",
}: {
  hidden?: "activity-timeline" | "time-billing";
  denied?: boolean;
  extra?: Record<string, unknown>;
  missingMatter?: boolean;
  picker?: boolean;
  candidates?: boolean;
  color?: string | null;
}) => {
  const inserted: unknown[] = [];
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
        rateTables: { findFirst: async () => undefined },
      },
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [
                  {
                    id: WORKSPACE_ID,
                    name: "Matter",
                    reference: "M-1",
                    color,
                    clientName: "Client",
                    lastWorkedAt: "2026-10-08",
                    newlyAssignedAt: null,
                    upcomingDeadline: "2026-10-12",
                  },
                ],
              }),
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
        identity: { email: "desktop@example.test", emailVerified: true },
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
      },
    },
  );
  const authorizeAccount = async () =>
    Result.ok({
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
  const endpointApp = new Elysia({ normalize: false })
    .get("/v1/desktop/matter-candidates", candidateEndpoint.handler, {
      response: candidateEndpoint.config.response,
    })
    .put("/v1/desktop/time-entries/:workspaceId", create.handler, {
      body: create.config.body,
      params: create.config.params,
      response: create.config.response,
    })
    .get("/v1/desktop/matters", matters.handler, {
      query: matters.config.query,
      response: matters.config.response,
    });
  const app = new Elysia().use(endpointApp);
  testState.setConfig("FEATURE_TIME_BILLING", true);
  testState.setConfig("API_FEATURE_ACCESS_GRANTS", {
    "activity-timeline":
      hidden === "activity-timeline"
        ? []
        : [
            {
              type: "member",
              organizationId: ORGANIZATION_ID,
              email: "desktop@example.test",
            },
          ],
  });
  let url = `http://localhost/v1/desktop/time-entries/${WORKSPACE_ID}`;
  if (picker) {
    url = "http://localhost/v1/desktop/matters?query=Matter";
  }
  if (candidates) {
    url = "http://localhost/v1/desktop/matter-candidates";
  }
  const response = await app.handle(
    new Request(
      url,
      picker || candidates
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
  });
  expect(result.inserted).toEqual([]);
  for (const hidden of ["activity-timeline", "time-billing"] as const) {
    expect((await exercise({ candidates: true, hidden })).status).toBe(403);
  }
});
