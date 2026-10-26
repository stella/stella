import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organizationSettings } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import { createSetSharepointCapabilities } from "@/api/handlers/sharepoint/set-capabilities";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestIds,
  setupRlsTestData,
} from "@/api/tests/security/rls-helpers";
import type { TestIds } from "@/api/tests/security/rls-helpers";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

let testDb: TestDatabase;
let ids: TestIds;

beforeAll(async () => {
  testDb = await getTestDb();
  ids = createTestIds();
  await setupRlsTestData(testDb, ids);
});

afterAll(async () => {
  await releaseTestDb();
});

test("selective file opt-out retains calendar policy only for the authorized org", async () => {
  await testDb
    .update(organizationSettings)
    .set({ sharepointConnectionEnabled: true })
    .where(eq(organizationSettings.organizationId, ids.orgA));
  const otherBefore = await testDb
    .select({
      file: organizationSettings.sharepointConnectionEnabled,
      calendar: organizationSettings.microsoft365CalendarReadEnabled,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, ids.orgB));

  const events: AuditEvent[] = [];
  const recordAuditEvent: AuditRecorder = async (_tx, event) => {
    events.push(...(Array.isArray(event) ? event : [event]));
  };
  const handler = createSetSharepointCapabilities(() => true);
  const result = await handler.handler(
    asTestRaw({
      body: { capabilities: ["calendar.read"] },
      safeDb: createSafeDb(testDb, [], ids.orgA, ids.userA1),
      session: { activeOrganizationId: ids.orgA },
      user: { id: ids.userA1 },
      memberRole: sessionMemberRole("owner"),
      recordAuditEvent,
      request: new Request(
        "https://api.example.test/v1/sharepoint/capabilities",
      ),
      route: "/v1/sharepoint/capabilities",
    }),
  );
  expect(result).toEqual({ capabilities: ["calendar.read"] });
  expect(
    await testDb
      .select({
        file: organizationSettings.sharepointConnectionEnabled,
        calendar: organizationSettings.microsoft365CalendarReadEnabled,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, ids.orgA)),
  ).toEqual([{ file: false, calendar: true }]);
  expect(
    await testDb
      .select({
        file: organizationSettings.sharepointConnectionEnabled,
        calendar: organizationSettings.microsoft365CalendarReadEnabled,
      })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, ids.orgB)),
  ).toEqual(otherBefore);
  expect(events).toHaveLength(1);
  expect(events[0]?.changes).toMatchObject({
    sharepointConnectionEnabled: { old: true, new: false },
    microsoft365CalendarReadEnabled: { old: false, new: true },
  });
});
