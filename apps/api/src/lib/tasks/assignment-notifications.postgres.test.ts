import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import { entities, workspaceMembers, workspaces } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { TASK_ASSIGNEE_ROLE } from "@/api/lib/entity-constants";
import type { TaskAssigneeRole } from "@/api/lib/entity-constants";
import { writeTaskAssignments } from "@/api/lib/tasks/assignment-membership";
import { taskAssignedNotifications } from "@/api/lib/tasks/assignment-notifications";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// timeout: each test opens gated clients on a shared database and seeds an organization first.
setDefaultTimeout(60_000);
const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("task assigned notifications (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests).toBe(true);
    });
  });
} else {
  test("a person made the assignee again after reviewing is told again", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const actorUserId = mintAuthProviderId<"user">();
      const colleagueId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const taskId = createSafeId<"entity">();
      await db.insert(user).values(
        [actorUserId, colleagueId].map((id) => ({
          id,
          name: "Assignment member",
          email: `${id}@example.test`,
        })),
      );
      try {
        await db.insert(organization).values({
          id: organizationId,
          name: "Assignment organization",
          slug: organizationId,
          createdAt: new Date(),
        });
        await db.insert(member).values(
          [actorUserId, colleagueId].map((userId) => ({
            id: Bun.randomUUIDv7(),
            organizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          })),
        );
        await db.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Assignment matter",
          reference: workspaceId,
        });
        await db.insert(workspaceMembers).values(
          [actorUserId, colleagueId].map((userId) => ({
            workspaceId,
            userId,
          })),
        );
        await db.insert(entities).values({
          id: taskId,
          workspaceId,
          kind: "task",
          name: "Review the lease",
        });

        // Each role change is its own request, so its own transaction.
        const assign = async (role: TaskAssigneeRole) =>
          await db.transaction(async (raw) => {
            const tx = asTestRaw<Transaction>(raw);
            const written = await writeTaskAssignments({
              tx,
              workspaceId,
              assignments: [{ entityId: taskId, userId: colleagueId, role }],
            });
            return await taskAssignedNotifications(tx, {
              actorUserId,
              workspaceId,
              written,
            });
          });

        const first = await assign(TASK_ASSIGNEE_ROLE.ASSIGNEE);
        const repeated = await assign(TASK_ASSIGNEE_ROLE.ASSIGNEE);
        const reviewing = await assign(TASK_ASSIGNEE_ROLE.REVIEWER);
        const again = await assign(TASK_ASSIGNEE_ROLE.ASSIGNEE);

        expect(first).toHaveLength(1);
        expect(repeated).toEqual([]);
        expect(reviewing).toEqual([]);
        expect(again).toHaveLength(1);
        expect(again[0]?.userId).toBe(colleagueId);
        expect(again[0]?.idempotencyKey).not.toBe(first[0]?.idempotencyKey);
      } finally {
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
        await db
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await db
          .delete(user)
          .where(inArray(user.id, [actorUserId, colleagueId]));
      }
    });
  });
}
