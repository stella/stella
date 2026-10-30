import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { organization } from "@/api/db/auth-schema";
import { organizationSettings } from "@/api/db/schema";
import { AUDIT_ACTION } from "@/api/lib/audit-log";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { lockSharepointPolicy } from "@/api/lib/db/sharepoint-policy-lock";
import { purgeSharepointForOrg } from "@/api/lib/sharepoint-disable-purge";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("SharePoint policy row serialization (postgres)", () => {
    test("requires a gated PostgreSQL database", () => {});
  });
} else {
  // timeout: two real sessions intentionally wait on the same policy row before either commits.
  test("an absent settings row serializes selective policy and whole-org kill", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const events: AuditEvent[] = [];
      const recordAuditEvent: AuditRecorder = async (_tx, event) => {
        events.push(...(Array.isArray(event) ? event : [event]));
      };
      await db.insert(organization).values({
        id: organizationId,
        name: "SharePoint policy lock fixture",
        slug: `sharepoint-policy-${organizationId}`,
        createdAt: new Date(),
      });
      try {
        await withInterleaving({
          databaseUrl,
          schedules: [["a.selective", "b.kill", "a.commit", "b.commit"]],
          a: {
            steps: [
              {
                name: "selective",
                run: async (tx) => {
                  const prior = await lockSharepointPolicy({
                    tx,
                    organizationId,
                    recordAuditEvent,
                  });
                  expect(prior).toEqual({
                    sharepointConnectionEnabled: false,
                    microsoft365CalendarReadEnabled: false,
                  });
                  await tx
                    .update(organizationSettings)
                    .set({
                      sharepointConnectionEnabled: true,
                      microsoft365CalendarReadEnabled: true,
                    })
                    .where(
                      eq(organizationSettings.organizationId, organizationId),
                    );
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "kill",
                run: async (tx) => {
                  await purgeSharepointForOrg(tx, {
                    organizationId,
                    recordAuditEvent,
                  });
                },
              },
            ],
          },
          reset: async () => {
            events.length = 0;
            await db
              .delete(organizationSettings)
              .where(eq(organizationSettings.organizationId, organizationId));
          },
          readState: async () =>
            await db
              .select({
                file: organizationSettings.sharepointConnectionEnabled,
                calendar: organizationSettings.microsoft365CalendarReadEnabled,
              })
              .from(organizationSettings)
              .where(eq(organizationSettings.organizationId, organizationId)),
          invariant: ({ blocked, outcomes, state, sessions }) => {
            expect(sessions.a.pid).not.toBe(sessions.b.pid);
            expect(blocked).toEqual(["b.kill"]);
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
            expect(state).toEqual([{ file: false, calendar: false }]);
            expect(events.map(({ action }) => action)).toEqual([
              AUDIT_ACTION.CREATE,
              AUDIT_ACTION.UPDATE,
              AUDIT_ACTION.DELETE,
            ]);
            expect(events.at(0)?.metadata).toMatchObject({
              operation: "sharepoint_policy_row_created",
            });
            expect(events.at(2)?.metadata).toMatchObject({
              operation: "sharepoint_oauth_disconnect",
              scope: "org_disable_purge",
            });
            expect(events.at(1)?.changes).toMatchObject({
              sharepointConnectionEnabled: { old: true, new: false },
              microsoft365CalendarReadEnabled: { old: true, new: false },
            });
          },
        });
      } finally {
        await db
          .delete(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId));
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
      }
    });
  }, 20_000);
}
