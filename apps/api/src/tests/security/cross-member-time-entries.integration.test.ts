import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  entities,
  TIME_ENTRY_SOURCE,
  timeEntries,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import batchDelete from "@/api/handlers/time-entries/batch/delete";
import batchUpdate from "@/api/handlers/time-entries/batch/update";
import deleteTimeEntryById from "@/api/handlers/time-entries/delete";
import splitEntry from "@/api/handlers/time-entries/split";
import timerStop from "@/api/handlers/time-entries/timer/stop";
import updateTimeEntryById from "@/api/handlers/time-entries/update";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { formatTodayInTimeZone } from "@/api/lib/timezone";
import type { McpRequestContext } from "@/api/mcp/context";
import { handleMcpToolCall } from "@/api/mcp/tools";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

setDefaultTimeout(120_000);

// Ownership of a time entry is decided by the handlers, not by row-level
// security: every member of the matter can see every entry in it. These
// suites drive the real handlers against the database with several members
// of ONE organization and check what each of them can change.

type Role = "owner" | "admin" | "member";
type Actor = { userId: SafeId<"user">; role: Role };
type ActorName = "timekeeper" | "colleague" | "admin" | "owner";

let testDb: TestDatabase;
let organizationId: SafeId<"organization">;
let workspaceId: SafeId<"workspace">;
let workItemA: SafeId<"entity">;
let workItemB: SafeId<"entity">;
let today: string;
let actors: Record<ActorName, Actor>;

const ORIGINAL_NARRATIVE = "Drafted the engagement letter";
const noopAuditRecorder: AuditRecorder = async () => undefined;

const createUser = async (name: string): Promise<SafeId<"user">> => {
  const userId = mintAuthProviderId<"user">();
  await testDb
    .insert(user)
    .values({ id: userId, name, email: `${userId}@test.local` });
  return userId;
};

beforeAll(async () => {
  testDb = await getTestDb();
  const todayResult = formatTodayInTimeZone({ timezoneId: "UTC" });
  if (Result.isError(todayResult)) {
    throw todayResult.error;
  }
  today = todayResult.value;

  organizationId = mintAuthProviderId<"organization">();
  await testDb.insert(organization).values({
    id: organizationId,
    name: "Time firm",
    slug: `time-firm-${organizationId}`,
    createdAt: new Date(),
  });

  actors = {
    timekeeper: { userId: await createUser("Timekeeper"), role: "member" },
    colleague: { userId: await createUser("Colleague"), role: "member" },
    admin: { userId: await createUser("Admin"), role: "admin" },
    owner: { userId: await createUser("Owner"), role: "owner" },
  };
  await testDb.insert(member).values(
    Object.values(actors).map((actor) => ({
      id: mintAuthProviderIdValue(),
      organizationId,
      userId: actor.userId,
      role: actor.role,
      createdAt: new Date(),
    })),
  );

  workspaceId = createSafeId<"workspace">();
  await testDb.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Shared matter",
    reference: `TM-${workspaceId.slice(-6)}`,
    status: "active",
  });
  // Both members staff the same matter, so neither is kept out by matter
  // access: only the entry's owner can stop one from touching the other's.
  await testDb.insert(workspaceMembers).values(
    Object.values(actors).map((actor) => ({
      id: createSafeId<"workspaceMember">(),
      workspaceId,
      userId: actor.userId,
    })),
  );

  workItemA = createSafeId<"entity">();
  workItemB = createSafeId<"entity">();
  await testDb.insert(entities).values([
    { id: workItemA, workspaceId, kind: "document", name: "Work item A" },
    { id: workItemB, workspaceId, kind: "document", name: "Work item B" },
  ]);
});

afterAll(async () => {
  await testDb
    .delete(timeEntries)
    .where(eq(timeEntries.workspaceId, workspaceId));
  await releaseTestDb();
});

// ── Fixtures ───────────────────────────────────────────

const seedEntry = async ({
  owner,
  running = false,
}: {
  owner: ActorName;
  running?: boolean;
}): Promise<SafeId<"timeEntry">> => {
  const id = createSafeId<"timeEntry">();
  await testDb.insert(timeEntries).values({
    id,
    organizationId,
    workspaceId,
    userId: actors[owner].userId,
    workItemId: workItemA,
    dateWorked: today,
    timezoneId: "UTC",
    durationMinutes: running ? 0 : 60,
    billedMinutes: running ? 0 : 60,
    rateAtEntry: cents(200),
    currency: "USD",
    narrative: ORIGINAL_NARRATIVE,
    billable: true,
    status: BILLING_STATUS.DRAFT,
    ...(running
      ? {
          source: TIME_ENTRY_SOURCE.TIMER,
          timerStartedAt: new Date(Date.now() - 30 * 60_000),
        }
      : {}),
  });
  return id;
};

const readEntry = async (id: SafeId<"timeEntry">) => {
  const [row] = await testDb
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.id, id));
  return row ?? null;
};

const readSplitSuccessors = async (id: SafeId<"timeEntry">) =>
  await testDb
    .select({ userId: timeEntries.userId })
    .from(timeEntries)
    .where(eq(timeEntries.splitGroupId, id));

// ── Handler contexts ───────────────────────────────────

const contextFor = (name: ActorName) => {
  const actor = actors[name];
  const workspaceIds = [workspaceId];
  return {
    createAuditRecorder: () => noopAuditRecorder,
    getActiveWorkspaceIds: async () => workspaceIds,
    getAccessibleWorkspaces: async () =>
      workspaceIds.map((id) => ({ id, status: "active" as const })),
    getWorkspaceAccess: async (targetWorkspaceId: SafeId<"workspace">) =>
      targetWorkspaceId === workspaceId
        ? { id: targetWorkspaceId, status: "active" as const }
        : null,
    memberRole: { role: actor.role },
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    promptCachingEnabled: false,
    recordAuditEvent: noopAuditRecorder,
    request: new Request(`https://example.test/workspaces/${workspaceId}`),
    route: "/security/cross-member-time-entries",
    safeDb: createSafeDb(testDb, workspaceIds, organizationId, actor.userId),
    scopedDb: createScopedDb(
      testDb,
      workspaceIds,
      organizationId,
      actor.userId,
    ),
    session: { activeOrganizationId: organizationId },
    user: { id: actor.userId },
    workspaceId,
  };
};

type UpdateCtx = Parameters<typeof updateTimeEntryById.handler>[0];
type DeleteCtx = Parameters<typeof deleteTimeEntryById.handler>[0];
type BatchUpdateCtx = Parameters<typeof batchUpdate.handler>[0];
type BatchDeleteCtx = Parameters<typeof batchDelete.handler>[0];
type SplitCtx = Parameters<typeof splitEntry.handler>[0];
type TimerStopCtx = Parameters<typeof timerStop.handler>[0];

/** The failure status of a handler result, or null when it succeeded. */
const statusOf = (result: unknown): number | null =>
  result instanceof ElysiaCustomStatusResponse ? Number(result.code) : null;

// ── Per-entry operations ───────────────────────────────

type EntryOperation = {
  name: string;
  run: (actor: ActorName, id: SafeId<"timeEntry">) => Promise<unknown>;
  /** Refusal status when the caller may not touch the entry. */
  refusedStatus: number;
  /** Whether a plain member may run it on their own entry. */
  memberMayRunOnOwn: boolean;
  /** Checks the entry after a successful run. */
  expectApplied: (id: SafeId<"timeEntry">) => Promise<void>;
};

const entryOperations: EntryOperation[] = [
  {
    name: "update",
    run: async (actor, id) =>
      await updateTimeEntryById.handler(
        asTestRaw<UpdateCtx>({
          ...contextFor(actor),
          body: { id, narrative: "Rewritten", durationMinutes: 90 },
        }),
      ),
    refusedStatus: 404,
    memberMayRunOnOwn: true,
    expectApplied: async (id) => {
      expect(await readEntry(id)).toMatchObject({
        narrative: "Rewritten",
        durationMinutes: 90,
      });
    },
  },
  {
    name: "delete",
    run: async (actor, id) =>
      await deleteTimeEntryById.handler(
        asTestRaw<DeleteCtx>({ ...contextFor(actor), body: { id } }),
      ),
    refusedStatus: 404,
    memberMayRunOnOwn: true,
    expectApplied: async (id) => {
      expect(await readEntry(id)).toBeNull();
    },
  },
  {
    name: "batch update",
    run: async (actor, id) =>
      await batchUpdate.handler(
        asTestRaw<BatchUpdateCtx>({
          ...contextFor(actor),
          body: { ids: [id], action: "mark_non_billable" },
        }),
      ),
    refusedStatus: 403,
    memberMayRunOnOwn: false,
    expectApplied: async (id) => {
      expect(await readEntry(id)).toMatchObject({ billable: false });
    },
  },
  {
    name: "batch delete",
    run: async (actor, id) =>
      await batchDelete.handler(
        asTestRaw<BatchDeleteCtx>({
          ...contextFor(actor),
          body: { ids: [id] },
        }),
      ),
    refusedStatus: 403,
    memberMayRunOnOwn: false,
    expectApplied: async (id) => {
      expect(await readEntry(id)).toBeNull();
    },
  },
  {
    name: "split",
    run: async (actor, id) =>
      await splitEntry.handler(
        asTestRaw<SplitCtx>({
          ...contextFor(actor),
          body: {
            id,
            splits: [
              { workItemId: workItemA, percentage: 50 },
              { workItemId: workItemB, percentage: 50 },
            ],
          },
        }),
      ),
    refusedStatus: 403,
    memberMayRunOnOwn: false,
    expectApplied: async (id) => {
      expect(await readEntry(id)).toBeNull();
    },
  },
];

describe("time entry changes between members of one organization", () => {
  for (const operation of entryOperations) {
    describe(operation.name, () => {
      test("a member cannot change a colleague's entry", async () => {
        const id = await seedEntry({ owner: "timekeeper" });
        const before = await readEntry(id);

        const result = await operation.run("colleague", id);

        expect(statusOf(result)).toBe(operation.refusedStatus);
        expect(await readEntry(id)).toEqual(before);
      });

      for (const approver of ["admin", "owner"] as const) {
        test(`an ${approver} can change a member's entry`, async () => {
          const id = await seedEntry({ owner: "timekeeper" });

          const result = await operation.run(approver, id);

          expect(statusOf(result)).toBeNull();
          await operation.expectApplied(id);
        });
      }

      if (operation.memberMayRunOnOwn) {
        test("a member can change their own entry", async () => {
          const id = await seedEntry({ owner: "timekeeper" });

          const result = await operation.run("timekeeper", id);

          expect(statusOf(result)).toBeNull();
          await operation.expectApplied(id);
        });
      } else {
        test("a member cannot run it even on their own entry", async () => {
          const id = await seedEntry({ owner: "timekeeper" });
          const before = await readEntry(id);

          const result = await operation.run("timekeeper", id);

          expect(statusOf(result)).toBe(403);
          expect(await readEntry(id)).toEqual(before);
        });
      }
    });
  }

  test("a split keeps the original timekeeper on every successor", async () => {
    const id = await seedEntry({ owner: "timekeeper" });

    const result = await entryOperations
      .find((operation) => operation.name === "split")
      ?.run("owner", id);

    expect(statusOf(result)).toBeNull();
    const splitGroupId =
      result !== null &&
      typeof result === "object" &&
      "splitGroupId" in result &&
      typeof result.splitGroupId === "string"
        ? toSafeId<"timeEntry">(result.splitGroupId)
        : null;
    expect(splitGroupId).not.toBeNull();
    if (splitGroupId === null) {
      return;
    }
    const successors = await readSplitSuccessors(splitGroupId);
    expect(successors).toHaveLength(2);
    for (const successor of successors) {
      expect(successor.userId).toBe(actors.timekeeper.userId);
    }
  });
});

// ── Timer ──────────────────────────────────────────────

const stopTimerAs = async (actor: ActorName) =>
  await timerStop.handler(asTestRaw<TimerStopCtx>(contextFor(actor)));

describe("stopping a timer in a matter shared by several members", () => {
  test.each(["colleague", "admin", "owner"] as const)(
    "%s without a running timer cannot stop the timekeeper's",
    async (actor) => {
      const id = await seedEntry({ owner: "timekeeper", running: true });
      const before = await readEntry(id);

      const result = await stopTimerAs(actor);

      expect(statusOf(result)).toBe(404);
      expect(await readEntry(id)).toEqual(before);
      // Clean up so later cases start with no running timer for this user.
      await testDb.delete(timeEntries).where(eq(timeEntries.id, id));
    },
  );

  test("a colleague stops only their own timer while the timekeeper's runs", async () => {
    const timekeeperTimer = await seedEntry({
      owner: "timekeeper",
      running: true,
    });
    const colleagueTimer = await seedEntry({
      owner: "colleague",
      running: true,
    });
    const before = await readEntry(timekeeperTimer);

    const result = await stopTimerAs("colleague");

    expect(statusOf(result)).toBeNull();
    expect(result).toMatchObject({ id: colleagueTimer });
    expect(await readEntry(colleagueTimer)).toMatchObject({
      timerStartedAt: null,
      timerStoppedAt: expect.any(Date),
    });
    expect(await readEntry(timekeeperTimer)).toEqual(before);
    await testDb.delete(timeEntries).where(eq(timeEntries.id, timekeeperTimer));
  });

  test("the timekeeper can stop their own timer", async () => {
    const id = await seedEntry({ owner: "timekeeper", running: true });

    const result = await stopTimerAs("timekeeper");

    expect(statusOf(result)).toBeNull();
    expect(result).toMatchObject({ id });
    const after = await readEntry(id);
    expect(after?.timerStartedAt).toBeNull();
    expect(after?.durationMinutes).toBeGreaterThan(0);
  });
});

// ── MCP tools ──────────────────────────────────────────

const mcpContextFor = (name: ActorName): McpRequestContext => {
  const actor = actors[name];
  const workspaceIds = [workspaceId];
  const accessibleWorkspaces = workspaceIds.map((id) => ({
    id,
    status: "active" as const,
  }));
  return asTestRaw<McpRequestContext>({
    accessibleWorkspaceIds: workspaceIds,
    accessibleWorkspaceIdSet: new Set(workspaceIds),
    accessibleWorkspaceStatusById: new Map(
      accessibleWorkspaces.map((workspace) => [workspace.id, workspace.status]),
    ),
    accessibleWorkspaces,
    grantedScopes: ["stella:billing_write"],
    memberRole: actor.role,
    organizationId,
    recordAuditEvent: noopAuditRecorder,
    safeDb: asTestRaw<SafeDb>(
      createSafeDb(testDb, workspaceIds, organizationId, actor.userId),
    ),
    scopedDb: asTestRaw<ScopedDb>(
      createScopedDb(testDb, workspaceIds, organizationId, actor.userId),
    ),
    userId: actor.userId,
  });
};

type McpOperation = {
  name: string;
  toolName: string;
  args: (id: SafeId<"timeEntry">) => Record<string, unknown>;
  expectApplied: (id: SafeId<"timeEntry">) => Promise<void>;
};

const mcpOperations: McpOperation[] = [
  {
    name: "save_time_entry update",
    toolName: "save_time_entry",
    args: (id) => ({ time_entry_id: id, narrative: "Rewritten over MCP" }),
    expectApplied: async (id) => {
      expect(await readEntry(id)).toMatchObject({
        narrative: "Rewritten over MCP",
      });
    },
  },
  {
    name: "delete_time_entry",
    toolName: "delete_time_entry",
    args: (id) => ({ time_entry_id: id, confirm: true }),
    expectApplied: async (id) => {
      expect(await readEntry(id)).toBeNull();
    },
  },
];

describe("time entry MCP tools between members of one organization", () => {
  for (const operation of mcpOperations) {
    describe(operation.name, () => {
      test("a member cannot change a colleague's entry", async () => {
        const id = await seedEntry({ owner: "timekeeper" });
        const before = await readEntry(id);

        const result = await handleMcpToolCall({
          args: operation.args(id),
          context: mcpContextFor("colleague"),
          toolName: operation.toolName,
        });

        expect(result.isError).toBe(true);
        expect(await readEntry(id)).toEqual(before);
      });

      test.each(["admin", "owner", "timekeeper"] as const)(
        "%s can change the timekeeper's entry",
        async (actor) => {
          const id = await seedEntry({ owner: "timekeeper" });

          const result = await handleMcpToolCall({
            args: operation.args(id),
            context: mcpContextFor(actor),
            toolName: operation.toolName,
          });

          expect(result.isError).not.toBe(true);
          await operation.expectApplied(id);
        },
      );
    });
  }
});
