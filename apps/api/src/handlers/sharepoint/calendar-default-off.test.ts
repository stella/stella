import { panic } from "better-result";
import { beforeEach, expect, test } from "bun:test";
import * as v from "valibot";

import { createTestState } from "@stll/test-state";

import type { SafeDb } from "@/api/db/safe-db";
import { organizationSettings } from "@/api/db/schema";
import { env } from "@/api/env";
import { featureFlagSchema } from "@/api/env-base-schema";
import { loadCalendarTools } from "@/api/handlers/chat/tools/calendar-tools";
import { sharepointRoute } from "@/api/handlers/sharepoint/routes";
import setSharepointCapabilities from "@/api/handlers/sharepoint/set-capabilities";
import { HttpStatusResponse } from "@/api/http/status";
import { capabilityEnabled } from "@/api/lib/auth/microsoft365/capabilities";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { classifyRouteGate } from "@/api/lib/route-gates";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const organizationId = mintAuthProviderId<"organization">();
const userId = mintAuthProviderId<"user">();
const testState = createTestState({ file: import.meta.path, config: env });
beforeEach(() => testState.setConfig("FEATURE_SHAREPOINT", false));

const untouchedDb: SafeDb = async () =>
  panic("A disabled calendar capability must not read the database");

test("an unset deployment flag and a new organization leave calendar reads off", () => {
  expect(v.parse(featureFlagSchema, undefined)).toBe(false);
  const calendarColumn = organizationSettings.microsoft365CalendarReadEnabled;
  expect(calendarColumn.notNull).toBe(true);
  expect(calendarColumn.default).toBe(false);
  expect(
    capabilityEnabled(
      {
        sharepointConnectionEnabled: false,
        microsoft365CalendarReadEnabled: calendarColumn.default === true,
      },
      "calendar.read",
    ),
  ).toBe(false);
  expect(capabilityEnabled(null, "calendar.read")).toBe(false);
});

test("the capability policy route is mounted only behind the SharePoint deployment gate", () => {
  const entry = sharepointRoute.find(
    (route) =>
      route.method === "PUT" && route.path.endsWith("/sharepoint/capabilities"),
  );
  if (!entry) {
    return panic("Expected the capability policy route");
  }
  expect(entry.middleware.map(classifyRouteGate)).toContainEqual({
    kind: "deployment-feature",
    flag: "FEATURE_SHAREPOINT",
  });
});

test("the capability policy handler refuses every change while the deployment flag is off", async () => {
  for (const capabilities of [[], ["calendar.read"]] as const) {
    const outcome = await setSharepointCapabilities.handler(
      asTestRaw<Parameters<typeof setSharepointCapabilities.handler>[0]>({
        body: { capabilities: [...capabilities] },
        session: { activeOrganizationId: organizationId },
        user: { id: userId },
        memberRole: sessionMemberRole("owner"),
        safeDb: untouchedDb,
        recordAuditEvent: async () => {
          await Promise.resolve();
        },
        request: new Request(
          "https://api.example.test/v1/sharepoint/capabilities",
          {
            method: "PUT",
          },
        ),
        route: "/v1/sharepoint/capabilities",
      }),
    );
    expect(outcome).toBeInstanceOf(HttpStatusResponse);
    expect(outcome).toMatchObject({ code: 404 });
  }
});

test("chat registers no calendar tools while the deployment flag is off", async () => {
  const tools = await loadCalendarTools({
    safeDb: untouchedDb,
    recordAuditEvent: async () => {
      await Promise.resolve();
    },
    organizationId,
    userId,
    createAbortSignal: () => new AbortController().signal,
  });
  expect(tools.unwrap()).toBeUndefined();
});
