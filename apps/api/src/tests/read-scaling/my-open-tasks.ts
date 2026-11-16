import { panic } from "better-result";
import { inArray } from "drizzle-orm";

import { TASK_STATUS } from "@stll/api-contract/entity-options";

import { entities, taskAssignees, workspaces } from "@/api/db/schema";
import { createSafeDb } from "@/api/db/scoped";
import listMyOpenTasks from "@/api/handlers/tasks/list";
import { HttpStatusResponse } from "@/api/http/status";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import {
  queryCountLogger,
  runWithMeasuredQueryCounter,
} from "@/api/lib/db-query-counter";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  type TestDatabase,
  withQueryLogger,
} from "@/api/tests/security/test-utils";

/** The page the scenario reads: the fixed response size. */
const PAGE_SIZE = 10;

type SeedOptions = {
  organizationId: SafeId<"organization">;
  clientId: SafeId<"contact">;
  userId: SafeId<"user">;
  /** Matters the caller can open, each with one open and one done task. */
  size: number;
};

/**
 * Seeds `size` matters, each holding one open and one finished task assigned
 * to the caller, so the population of matters and tasks grows while the
 * first page stays ten rows long.
 */
export const seedMyOpenTasksScaling = async (
  database: TestDatabase,
  { organizationId, clientId, userId, size }: SeedOptions,
) => {
  const matters = Array.from({ length: size }, () =>
    createSafeId<"workspace">(),
  );
  await database.insert(workspaces).values(
    matters.map((id) => ({
      id,
      organizationId,
      clientId,
      name: `Scaling matter ${id}`,
      reference: `SCALE-${id}`,
    })),
  );
  const tasks = matters.flatMap((workspaceId) => [
    {
      id: createSafeId<"entity">(),
      workspaceId,
      kind: "task" as const,
      name: `Open task ${workspaceId}`,
      status: TASK_STATUS.OPEN,
      dueDate: "2030-01-01",
    },
    {
      id: createSafeId<"entity">(),
      workspaceId,
      kind: "task" as const,
      name: `Done task ${workspaceId}`,
      status: TASK_STATUS.DONE,
      dueDate: "2029-01-01",
    },
  ]);
  await database.insert(entities).values(tasks);
  await database.insert(taskAssignees).values(
    tasks.map((task) => ({
      id: createSafeId<"taskAssignee">(),
      entityId: task.id,
      workspaceId: task.workspaceId,
      userId,
      role: "assignee" as const,
    })),
  );
  const taskIds = tasks.map((task) => task.id);
  return {
    database: withQueryLogger(database, queryCountLogger),
    organizationId,
    userId,
    matters,
    cleanup: async () => {
      await database.delete(entities).where(inArray(entities.id, taskIds));
      await database.delete(workspaces).where(inArray(workspaces.id, matters));
    },
  };
};

type MyOpenTasksFixture = Awaited<ReturnType<typeof seedMyOpenTasksScaling>>;

export const myOpenTasksScalingScenario = {
  name: "my open tasks",
  definition: listMyOpenTasks,
  measure: async (fixture: MyOpenTasksFixture) =>
    await runWithMeasuredQueryCounter(async (counter) => {
      const response = await listMyOpenTasks.handler(
        asTestRaw<Parameters<typeof listMyOpenTasks.handler>[0]>({
          query: { limit: PAGE_SIZE },
          request: new Request("https://example.test/v1/tasks"),
          route: "/v1/tasks",
          safeDb: createSafeDb(
            fixture.database,
            fixture.matters,
            fixture.organizationId,
            fixture.userId,
          ),
          getActiveWorkspaceIds: async () =>
            await Promise.resolve(fixture.matters),
          session: { activeOrganizationId: fixture.organizationId },
          user: { id: fixture.userId },
          memberRole: sessionMemberRole("member"),
        }),
      );
      if (response instanceof HttpStatusResponse || !("items" in response)) {
        return panic("My open tasks scaling requires a successful response");
      }
      return {
        statements: counter.count,
        transactionRoundTrips: counter.transactions,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
        rows: response.items.length,
      };
    }),
};
