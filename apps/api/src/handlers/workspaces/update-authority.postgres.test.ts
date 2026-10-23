import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { MATTER_VISIBILITY } from "@stll/api-contract";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  SETTING_ORGANIZATION_ID,
  SETTING_USER_ID,
  SETTING_WORKSPACE_ACCESS_MODE,
  SETTING_WORKSPACE_IDS,
  WORKSPACE_ACCESS_MODE,
} from "@/api/db/rls";
import { safeDbFromScoped } from "@/api/db/safe-db";
import { workspaceMembers, workspaces } from "@/api/db/schema";
import { updateWorkspaceHandler } from "@/api/handlers/workspaces/update";
import type { AuditEvent, AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { lockMatterStewardship } from "@/api/lib/db/aggregate-lock";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { memberReachesMatterSql } from "@/api/lib/workspaces/authorized-workspace-ids";
import { insertWorkspaceRowsInTransaction } from "@/api/lib/workspaces/create-workspace-row";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("matter mutation authority after a lock wait", () => {
  test("a pinned unassigned administrator cannot widen a matter narrowed while waiting", async () => {
    if (!databaseUrl) {
      panic("DATABASE_URL required");
    }
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient({ max: 1 });
      const organizationId = mintAuthProviderId<"organization">();
      const leadUserId = mintAuthProviderId<"user">();
      const ownerUserId = mintAuthProviderId<"user">();
      const adminUserId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const suffix = Bun.randomUUIDv7().replaceAll("-", "");
      const userIds = [leadUserId, ownerUserId, adminUserId];
      const requests = [
        { organizationId, workspaceIds: [workspaceId], userIds },
      ];
      const events: AuditEvent[] = [];
      const refusals: { status: number; message: string }[] = [];
      const recordAuditEvent: AuditRecorder = (_tx, event) => {
        events.push(...(Array.isArray(event) ? event : [event]));
      };
      await db.insert(organization).values({
        id: organizationId,
        name: "Mutation authority",
        slug: `mutation-authority-${suffix}`,
        createdAt: new Date(),
      });
      await db.insert(user).values(
        userIds.map((id) => ({
          id,
          name: "Authority fixture",
          email: `${id}-${suffix}@example.test`,
        })),
      );
      await db.insert(member).values([
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: leadUserId,
          role: "member",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: ownerUserId,
          role: "owner",
          createdAt: new Date(),
        },
        {
          id: mintAuthProviderIdValue(),
          organizationId,
          userId: adminUserId,
          role: "admin",
          createdAt: new Date(),
        },
      ]);
      await db.transaction(async (tx) => {
        await insertWorkspaceRowsInTransaction({
          tx,
          candidateUserIds: userIds,
          rows: [
            {
              id: workspaceId,
              organizationId,
              name: "Unchanged matter",
              reference: suffix,
              leadUserId,
              visibility: MATTER_VISIBILITY.adminsAndAssigned,
            },
          ],
        });
        await tx
          .insert(workspaceMembers)
          .values({ workspaceId, userId: leadUserId });
      });
      try {
        await withInterleaving({
          databaseUrl,
          schedules: [
            [
              "a.narrow",
              "b.authorizeAndPin",
              "b.update",
              "a.commit",
              "b.commit",
            ],
          ],
          a: {
            steps: [
              {
                name: "narrow",
                run: async (tx) => {
                  await lockMatterStewardship({ tx, requests, mode: "update" });
                  await tx
                    .update(workspaces)
                    .set({ visibility: MATTER_VISIBILITY.assignedOnly })
                    .where(eq(workspaces.id, workspaceId));
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "authorizeAndPin",
                run: async (tx) => {
                  const [matter] = await tx
                    .select({
                      reaches: memberReachesMatterSql(
                        { organizationId, userId: adminUserId },
                        workspaces.id,
                      ),
                    })
                    .from(workspaces)
                    .where(eq(workspaces.id, workspaceId));
                  expect(matter?.reaches).toBe(true);
                  await tx.execute(sql`SELECT
                set_config(${SETTING_ORGANIZATION_ID}, ${organizationId}, true),
                set_config(${SETTING_USER_ID}, ${adminUserId}, true),
                set_config(${SETTING_WORKSPACE_IDS}, ${`{${workspaceId}}`}, true),
                set_config(${SETTING_WORKSPACE_ACCESS_MODE}, ${WORKSPACE_ACCESS_MODE.explicit}, true)`);
                },
              },
              {
                name: "update",
                run: async (tx) => {
                  // Root access reproduces a request's stale RLS pin: only the
                  // handler's fresh authority check can refuse this mutation.
                  const safeDb = safeDbFromScoped(async (run) => await run(tx));
                  const result = await Result.gen(() =>
                    updateWorkspaceHandler({
                      actor: {
                        userId: adminUserId,
                        managesOrganizationMatters: true,
                      },
                      safeDb,
                      organizationId,
                      workspaceId,
                      recordAuditEvent,
                      body: {
                        name: "Unauthorized change",
                        visibility: MATTER_VISIBILITY.allMembers,
                      },
                    }),
                  );
                  if (result.isOk() || !HandlerError.is(result.error)) {
                    panic("Expected an opaque matter authorization refusal");
                  }
                  expect(result.error.affectedMatters).toBeUndefined();
                  refusals.push({
                    status: result.error.status,
                    message: result.error.message,
                  });
                },
              },
            ],
          },
          reset: async () => {
            expect(
              (
                await db
                  .select({ visibility: workspaces.visibility })
                  .from(workspaces)
                  .where(eq(workspaces.id, workspaceId))
              ).at(0)?.visibility,
            ).toBe(MATTER_VISIBILITY.adminsAndAssigned);
          },
          readState: async () =>
            (
              await db
                .select({
                  name: workspaces.name,
                  visibility: workspaces.visibility,
                  leadUserId: workspaces.leadUserId,
                  adminReaches: memberReachesMatterSql(
                    { organizationId, userId: adminUserId },
                    workspaces.id,
                  ),
                })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId))
            ).at(0),
          invariant: ({ outcomes, blocked, state }) => {
            expect(outcomes.a.status).not.toBe("deadlock");
            expect(outcomes.b.status).not.toBe("deadlock");
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
            expect(blocked).toContain("b.update");
            expect(refusals).toEqual([
              { status: 404, message: "Workspace not found" },
            ]);
            expect(events).toEqual([]);
            expect(state).toEqual({
              name: "Unchanged matter",
              visibility: MATTER_VISIBILITY.assignedOnly,
              leadUserId,
              adminReaches: false,
            });
          },
        });
      } finally {
        await db.transaction(async (tx) => {
          await lockMatterStewardship({ tx, requests, mode: "update" });
          await tx
            .delete(organization)
            .where(eq(organization.id, organizationId));
        });
        for (const userId of userIds) {
          await db.delete(user).where(eq(user.id, userId));
        }
      }
    });
  });
});
