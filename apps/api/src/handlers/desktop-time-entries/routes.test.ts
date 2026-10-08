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
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { createDesktopTimeEntryEndpoint } from "./create";
import { createDesktopMattersEndpoint } from "./matters";
import { desktopTimeEntriesRoute } from "./routes";

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
  for (const path of ["matters", `time-entries/${WORKSPACE_ID}`]) {
    const response = await app.handle(
      new Request(
        `http://localhost/v1/desktop/${path}`,
        path === "matters"
          ? {}
          : {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(BODY),
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
}: {
  hidden?: "activity-timeline" | "time-billing";
  denied?: boolean;
  extra?: Record<string, unknown>;
  missingMatter?: boolean;
  picker?: boolean;
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
              clientId: null,
            },
          ],
        },
        organizationSettings: { findFirst: async () => DEFAULT_TIME_POLICY },
        rateTables: { findFirst: async () => undefined },
      },
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
  const app = new Elysia()
    .put("/v1/desktop/time-entries/:workspaceId", create.handler, {
      body: create.config.body,
      params: create.config.params,
      response: create.config.response,
      normalize: false,
    })
    .get("/v1/desktop/matters", matters.handler, {
      query: matters.config.query,
      response: matters.config.response,
    });
  const previous = env.API_FEATURE_ACCESS_GRANTS;
  const previousDeployment = env.FEATURE_TIME_BILLING;
  env.FEATURE_TIME_BILLING = true;
  env.API_FEATURE_ACCESS_GRANTS = {
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
  };
  try {
    const response = await app.handle(
      new Request(
        picker
          ? "http://localhost/v1/desktop/matters?query=Matter"
          : `http://localhost/v1/desktop/time-entries/${WORKSPACE_ID}`,
        picker
          ? {}
          : {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...BODY, ...extra }),
            },
      ),
    );
    return { status: response.status, body: await response.json(), inserted };
  } finally {
    env.API_FEATURE_ACCESS_GRANTS = previous;
    env.FEATURE_TIME_BILLING = previousDeployment;
  }
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

test("picker projects only matter identity and display fields", async () => {
  expect((await exercise({ picker: true })).body).toEqual({
    matters: [{ id: WORKSPACE_ID, name: "Matter", reference: "M-1" }],
  });
});
