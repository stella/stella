import { panic } from "better-result";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { member, organization, user } from "@/api/db/auth-schema";
import {
  entities,
  taskAssignees,
  workObligations,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { env } from "@/api/env";
import { createSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import { brandPersistedEntityId } from "@/api/lib/safe-id-boundaries";
import { backfillWorkObligations } from "@/api/lib/scheduler/tasks/work-obligation-backfill";
import type { SchedulerTaskContext } from "@/api/lib/scheduler/types";
import { recordNewOrganizationAccessState } from "@/api/lib/usage/organization-access-state";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { createTestState } from "@/api/tests/helpers/test-state";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { waitForBlockedPid } from "@/api/tests/helpers/wait-for-blocked-pid";

// timeout: three pooled clients connect and seed before the lock barrier
setDefaultTimeout(60_000);
const testState = createTestState({ file: import.meta.path, config: env });
const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// The backfill walks every entity after its cursor; these ids sort last, so
// the page holds only this fixture's task.
const CURSOR = "ffffffff-ffff-7fff-bfff-ffffffffff00";
const FIXTURE_TASK_ID = "ffffffff-ffff-7fff-bfff-ffffffffff01";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("work-obligation backfill assignments (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests).toBe(true);
    });
  });
} else {
  test("an assignee removed while the backfill waits for the task is never recorded", async () => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      const { db: backfillDb } = openClient();
      const { db: writerDb } = openClient();
      const { sql: observer } = openClient();
      const organizationId = mintAuthProviderId<"organization">();
      const formerId = mintAuthProviderId<"user">();
      const keptId = mintAuthProviderId<"user">();
      const workspaceId = createSafeId<"workspace">();
      const taskId = brandPersistedEntityId(FIXTURE_TASK_ID);
      await writerDb.insert(user).values(
        [formerId, keptId].map((id) => ({
          id,
          name: "Assignee",
          email: `${id.toLowerCase()}@backfill.test`,
        })),
      );
      testState.setConfig("FEATURE_GOVERNED_WORKFLOW", true);
      try {
        await writerDb.insert(organization).values({
          id: organizationId,
          name: "Backfill",
          slug: organizationId,
          createdAt: new Date(),
        });
        await recordNewOrganizationAccessState(writerDb, {
          organizationId,
          now: new Date(),
        });
        await writerDb.insert(member).values(
          [formerId, keptId].map((userId) => ({
            id: Bun.randomUUIDv7(),
            organizationId,
            userId,
            role: "member",
            createdAt: new Date(),
          })),
        );
        await writerDb.insert(workspaces).values({
          id: workspaceId,
          organizationId,
          name: "Backfill matter",
          reference: workspaceId,
        });
        await writerDb.insert(workspaceMembers).values(
          [formerId, keptId].map((userId) => ({
            workspaceId,
            userId,
          })),
        );
        await writerDb.insert(entities).values({
          id: taskId,
          workspaceId,
          kind: "task",
          name: "Legacy task",
        });
        await writerDb.insert(taskAssignees).values(
          [formerId, keptId].map(
            (userId): typeof taskAssignees.$inferInsert => ({
              entityId: taskId,
              workspaceId,
              userId,
              role: "assignee",
            }),
          ),
        );
        const events: { event: string; status: unknown }[] = [];
        const run = async () =>
          await backfillWorkObligations(
            asTestRaw<SchedulerTaskContext>({
              db: backfillDb,
              job: {
                id: Bun.randomUUIDv7(),
                lockedBy: "backfill-test-lease",
                payload: { cursor: CURSOR },
              },
              signal: new AbortController().signal,
              logger: {
                ...logger,
                info: (event: string, fields?: Record<string, unknown>) => {
                  events.push({
                    event,
                    status: fields?.["workObligations.status"],
                  });
                },
              },
            }),
          );
        const [backfillWorker] = await backfillDb
          .select({ pid: sql<number>`pg_backend_pid()` })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId));
        if (!backfillWorker) {
          panic("The backfill session must exist");
        }

        let pending: ReturnType<typeof run> | undefined;
        // An assignment writer holds the task while it removes an assignee;
        // the backfill has read both assignees and waits for the task. Adding
        // one would need the matter row the backfill already holds, so a
        // writer that holds the task can only remove.
        await writerDb.transaction(async (tx) => {
          const [writer] = await tx
            .select({ pid: sql<number>`pg_backend_pid()` })
            .from(entities)
            .where(eq(entities.id, taskId))
            .for("update");
          if (!writer) {
            panic("The writer session must hold the task");
          }
          pending = run();
          await waitForBlockedPid(observer, {
            waitingPid: backfillWorker.pid,
            holdingPid: writer.pid,
          });
          await tx
            .delete(taskAssignees)
            .where(
              and(
                eq(taskAssignees.entityId, taskId),
                eq(taskAssignees.userId, formerId),
              ),
            );
        });
        if (pending === undefined) {
          panic("The racing backfill must have started");
        }
        await pending;
        // The assignees read under the task lock are the current ones: the
        // remaining assignee owns the work, which two stale assignees would not.
        expect(events.at(-1)?.status).toBe("progress");
        expect(
          await backfillDb
            .select({ ownerUserId: workObligations.ownerUserId })
            .from(workObligations)
            .where(eq(workObligations.entityId, taskId)),
        ).toEqual([{ ownerUserId: keptId }]);
      } finally {
        await writerDb
          .delete(organization)
          .where(eq(organization.id, organizationId));
        await writerDb.delete(user).where(inArray(user.id, [formerId, keptId]));
      }
    });
  });
}
