import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  auditLogs,
  organizationSettings,
  timeTimers,
  entities,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeTimers,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb } from "@/api/db/scoped";
import batchDelete from "@/api/handlers/time-entries/batch/delete";
import batchUpdate from "@/api/handlers/time-entries/batch/update";
import deleteTimeEntryById from "@/api/handlers/time-entries/delete";
import splitEntry from "@/api/handlers/time-entries/split";
import updateTimeEntryById from "@/api/handlers/time-entries/update";
import adminListTimers from "@/api/handlers/time-timers/admin/list";
import adminStopTimer from "@/api/handlers/time-timers/admin/stop";
import confirmTimer from "@/api/handlers/time-timers/confirm";
import discardTimer from "@/api/handlers/time-timers/discard";
import listTimers from "@/api/handlers/time-timers/list";
import pauseTimer from "@/api/handlers/time-timers/pause";
import resumeTimer from "@/api/handlers/time-timers/resume";
import updateTimer from "@/api/handlers/time-timers/update";
import { ORG_AI_CONFIG_STATUS } from "@/api/lib/ai-config-loader-core";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
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
    .delete(timeTimers)
    .where(eq(timeTimers.organizationId, organizationId));
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

const contextFor = (name: ActorName, recordAuditEvent = noopAuditRecorder) => {
  const actor = actors[name];
  const workspaceIds = [workspaceId];
  return {
    createAuditRecorder: () => recordAuditEvent,
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
    recordAuditEvent,
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
type ConfirmCtx = Parameters<typeof confirmTimer.handler>[0];
type AdminStopCtx = Parameters<typeof adminStopTimer.handler>[0];

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

// ── Timers ────────────────────────────────────────────

type SeedTimerOptions = {
  owner?: ActorName;
  matterId?: SafeId<"workspace"> | null;
  description?: string | null;
  state?: "running" | "paused";
  legacyId?: SafeId<"timeEntry">;
};
const seedTimer = async ({
  owner = "timekeeper",
  matterId = workspaceId,
  description = ORIGINAL_NARRATIVE,
  state = "running",
  legacyId,
}: SeedTimerOptions = {}) => {
  const id = createSafeId<"timeTimer">();
  await testDb.insert(timeTimers).values({
    id,
    organizationId,
    userId: actors[owner].userId,
    workspaceId: matterId,
    description,
    state,
    legacyTimeEntryId: legacyId,
    startedAt: new Date(Date.now() - 180_000),
    accumulatedSeconds: 0,
    lastResumedAt: state === "running" ? new Date(Date.now() - 180_000) : null,
  });
  return id;
};
const readTimer = async (id: SafeId<"timeTimer">) =>
  await testDb.query.timeTimers.findFirst({ where: { id: { eq: id } } });
const adminRecorder = (actor: "admin" | "owner") =>
  createBackgroundAuditRecorder({
    organizationId,
    workspaceId,
    userId: actors[actor].userId,
    execution: {
      performer: { type: "user", id: actors[actor].userId },
      trigger: { type: "direct" },
    },
  });
const stopAs = async ({
  actor,
  id,
  narrative,
}: {
  actor: ActorName;
  id: SafeId<"timeTimer">;
  narrative?: string;
}) =>
  await adminStopTimer.handler(
    asTestRaw<AdminStopCtx>({
      ...contextFor(
        actor,
        actor === "admin" || actor === "owner"
          ? adminRecorder(actor)
          : noopAuditRecorder,
      ),
      params: { id },
      body: { timezoneId: "UTC", narrative },
    }),
  );

const runningBatchActions = {
  approve: { action: "approve", status: BILLING_STATUS.DRAFT, billable: true },
  revert_to_draft: {
    action: "revert_to_draft",
    status: BILLING_STATUS.APPROVED,
    billable: true,
  },
  mark_billable: {
    action: "mark_billable",
    status: BILLING_STATUS.DRAFT,
    billable: false,
  },
  mark_non_billable: {
    action: "mark_non_billable",
    status: BILLING_STATUS.DRAFT,
    billable: true,
  },
} as const satisfies Record<
  BatchUpdateCtx["body"]["action"],
  {
    action: BatchUpdateCtx["body"]["action"];
    status: typeof BILLING_STATUS.DRAFT | typeof BILLING_STATUS.APPROVED;
    billable: boolean;
  }
>;

const runningOperations = [
  ...entryOperations.filter((operation) => operation.name !== "batch update"),
  ...Object.values(runningBatchActions).map(({ action, status, billable }) => ({
    name: `batch ${action}`,
    prepare: async (id: SafeId<"timeEntry">) => {
      await testDb
        .update(timeEntries)
        .set({ status, billable })
        .where(eq(timeEntries.id, id));
    },
    run: async (actor: ActorName, id: SafeId<"timeEntry">) =>
      await batchUpdate.handler(
        asTestRaw<BatchUpdateCtx>({
          ...contextFor(actor),
          body: { ids: [id], action },
        }),
      ),
  })),
];

type RunningEntryCase = {
  kind: "direct" | "migrated";
  operation: (typeof runningOperations)[number];
};

const assertRunningEntryRefusal = async ({
  kind,
  operation,
}: RunningEntryCase) => {
  const entryId = await seedEntry({
    owner: "timekeeper",
    running: kind === "direct",
  });
  const timerId =
    kind === "migrated" ? await seedTimer({ legacyId: entryId }) : null;
  if (kind === "migrated") {
    await testDb
      .update(timeEntries)
      .set({ source: TIME_ENTRY_SOURCE.TIMER })
      .where(eq(timeEntries.id, entryId));
  }
  if ("prepare" in operation) {
    await operation.prepare(entryId);
  }
  const before = await readEntry(entryId);
  const result = await operation.run("admin", entryId);
  expect(result).toMatchObject({
    code: 409,
    response: { error: "running_timer" },
  });
  expect(await readEntry(entryId)).toEqual(before);
  expect(await readSplitSuccessors(entryId)).toHaveLength(0);
  if (timerId) {
    await testDb.delete(timeTimers).where(eq(timeTimers.id, timerId));
  }
  await testDb.delete(timeEntries).where(eq(timeEntries.id, entryId));
};

const runningEntryCases = (["direct", "migrated"] as const).flatMap((kind) =>
  runningOperations.map((operation) => ({
    kind,
    operation,
    name: `${operation.name} refuses another member's ${kind} running entry`,
  })),
);

describe("running time belongs to its timekeeper until an admin ends it", () => {
  test.each(runningEntryCases)("$name", assertRunningEntryRefusal);

  test.each(["update", "delete"] as const)(
    "the timekeeper keeps their own running-entry %s behavior",
    async (name) => {
      const id = await seedEntry({ owner: "timekeeper", running: true });
      const operation = entryOperations.find(
        (candidate) => candidate.name === name,
      );
      expect(operation).toBeDefined();
      if (!operation) {
        throw new Error(`Missing operation ${name}`);
      }
      expect(statusOf(await operation.run("timekeeper", id))).toBeNull();
      await operation.expectApplied(id);
      await testDb.delete(timeEntries).where(eq(timeEntries.id, id));
    },
  );
});

describe("admin ending a member's timer", () => {
  test.each(["admin", "owner"] as const)(
    "%s ends into the timekeeper's draft with actor audit and convergent replay",
    async (actor) => {
      const id = await seedTimer();
      const result = await stopAs({ actor, id });
      if (statusOf(result) !== null || !("id" in result)) {
        throw new Error(`Admin stop failed: ${JSON.stringify(result)}`);
      }
      expect(await readTimer(id)).toBeUndefined();
      expect(await readEntry(result.id)).toMatchObject({
        userId: actors.timekeeper.userId,
        status: BILLING_STATUS.DRAFT,
        source: TIME_ENTRY_SOURCE.TIMER,
        narrative: ORIGINAL_NARRATIVE,
      });
      const events = await testDb
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.resourceId, id),
            eq(auditLogs.resourceType, AUDIT_RESOURCE_TYPE.TIME_TIMER),
          ),
        );
      expect(events).toHaveLength(1);
      expect(events.at(0)).toMatchObject({
        userId: actors[actor].userId,
        performerId: actors[actor].userId,
        action: AUDIT_ACTION.DELETE,
        changes: {
          endedByAdmin: { old: null, new: actors[actor].userId },
          ownerId: {
            old: actors.timekeeper.userId,
            new: actors.timekeeper.userId,
          },
          narrativeFromAdmin: { old: null, new: false },
        },
      });
      expect(await stopAs({ actor, id })).toEqual(result);
      expect(await stopAs({ actor, id })).toEqual(result);
      expect(
        await testDb
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.resourceId, id)),
      ).toHaveLength(1);
      expect(
        statusOf(
          await entryOperations
            .find((operation) => operation.name === "update")
            ?.run(actor, result.id),
        ),
      ).toBeNull();
      expect(
        statusOf(
          await entryOperations
            .find((operation) => operation.name === "delete")
            ?.run(actor, result.id),
        ),
      ).toBeNull();
      expect(await readEntry(result.id)).toBeNull();
    },
  );

  test("required narrative refusal keeps timer running; supplied narrative records provenance", async () => {
    await testDb.insert(organizationSettings).values({
      id: createSafeId<"organizationSettings">(),
      organizationId,
      timeNarrativeRequired: true,
    });
    const id = await seedTimer({ description: " " });
    const before = await readTimer(id);
    expect(await stopAs({ actor: "admin", id })).toMatchObject({
      code: 400,
      response: { error: "narrative_required" },
    });
    expect(await readTimer(id)).toEqual(before);
    const result = await stopAs({
      actor: "admin",
      id,
      narrative: "Research completed",
    });
    if (statusOf(result) !== null || !("id" in result)) {
      throw new Error(`Admin stop failed: ${JSON.stringify(result)}`);
    }
    expect(await readEntry(result.id)).toMatchObject({
      narrative: "Research completed",
      userId: actors.timekeeper.userId,
    });
    const event = await testDb.query.auditLogs.findFirst({
      where: { resourceId: { eq: id } },
    });
    expect(event).toMatchObject({
      changes: { narrativeFromAdmin: { old: null, new: true } },
    });
  });

  test("a supplied narrative does not replace a nonblank timer description", async () => {
    const id = await seedTimer();
    const result = await stopAs({
      actor: "admin",
      id,
      narrative: "Alternative narrative",
    });
    if (statusOf(result) !== null || !("id" in result)) {
      throw new Error(`Admin stop failed: ${JSON.stringify(result)}`);
    }
    expect(await readEntry(result.id)).toMatchObject({
      narrative: ORIGINAL_NARRATIVE,
    });
  });

  test.each(["missing matter", "paused"] as const)(
    "admin end refuses %s without a partial transition",
    async (reason) => {
      const id = await seedTimer(
        reason === "missing matter" ? { matterId: null } : { state: "paused" },
      );
      const before = await readTimer(id);
      expect(statusOf(await stopAs({ actor: "admin", id }))).not.toBeNull();
      expect(await readTimer(id)).toEqual(before);
      await testDb.delete(timeTimers).where(eq(timeTimers.id, id));
    },
  );

  test("plain members cannot list or end another member's timer", async () => {
    const id = await seedTimer();
    const before = await readTimer(id);
    const listed = await adminListTimers.handler(
      asTestRaw<Parameters<typeof adminListTimers.handler>[0]>({
        ...contextFor("colleague"),
        query: {},
      }),
    );
    expect(statusOf(listed)).toBe(403);
    expect(statusOf(await stopAs({ actor: "colleague", id }))).toBe(403);
    const ownList = await listTimers.handler(
      asTestRaw<Parameters<typeof listTimers.handler>[0]>({
        ...contextFor("colleague"),
        query: {},
      }),
    );
    expect(ownList).toMatchObject({ items: [] });
    expect(await readTimer(id)).toEqual(before);
    await testDb.delete(timeTimers).where(eq(timeTimers.id, id));
  });

  test("admin visibility does not grant owner timer actions", async () => {
    const id = await seedTimer();
    const before = await readTimer(id);
    expect(
      await updateTimer.handler(
        asTestRaw<Parameters<typeof updateTimer.handler>[0]>({
          ...contextFor("admin"),
          params: { id },
          body: { description: "Edited" },
        }),
      ),
    ).toMatchObject({ code: 404 });
    expect(
      await discardTimer.handler(
        asTestRaw<Parameters<typeof discardTimer.handler>[0]>({
          ...contextFor("admin"),
          params: { id },
        }),
      ),
    ).toMatchObject({ code: 404 });
    expect(
      await confirmTimer.handler(
        asTestRaw<ConfirmCtx>({
          ...contextFor("admin"),
          params: { id },
          body: { timezoneId: "UTC" },
        }),
      ),
    ).toMatchObject({ code: 404 });
    expect(
      await pauseTimer.handler(
        asTestRaw<Parameters<typeof pauseTimer.handler>[0]>({
          ...contextFor("admin"),
          params: { id },
        }),
      ),
    ).toMatchObject({ code: 404 });
    expect(
      await resumeTimer.handler(
        asTestRaw<Parameters<typeof resumeTimer.handler>[0]>({
          ...contextFor("admin"),
          params: { id },
        }),
      ),
    ).toMatchObject({ code: 404 });
    expect(await readTimer(id)).toEqual(before);
    await testDb.delete(timeTimers).where(eq(timeTimers.id, id));
  });

  test("ending a migrated running timer replaces its entry and permits later admin edits", async () => {
    const legacyId = await seedEntry({ owner: "timekeeper", running: true });
    const id = await seedTimer({ legacyId });
    const result = await stopAs({ actor: "admin", id });
    if (statusOf(result) !== null || !("id" in result)) {
      throw new Error(`Admin stop failed: ${JSON.stringify(result)}`);
    }
    expect(await readEntry(legacyId)).toBeNull();
    expect(await readTimer(id)).toBeUndefined();
    expect(await readEntry(result.id)).toMatchObject({
      timerStartedAt: null,
      userId: actors.timekeeper.userId,
    });
    expect(
      statusOf(
        await entryOperations
          .find((operation) => operation.name === "update")
          ?.run("admin", result.id),
      ),
    ).toBeNull();
    expect(
      statusOf(
        await entryOperations
          .find((operation) => operation.name === "delete")
          ?.run("admin", result.id),
      ),
    ).toBeNull();
  });
});

const confirmTimerAs = async (actor: ActorName, id: SafeId<"timeTimer">) =>
  await confirmTimer.handler(
    asTestRaw<ConfirmCtx>({
      ...contextFor(actor),
      params: { id },
      body: { timezoneId: "UTC" },
    }),
  );

describe("confirming a timer in a matter shared by several members", () => {
  test.each(["colleague", "admin", "owner"] as const)(
    "%s cannot confirm the timekeeper's timer",
    async (actor) => {
      const id = await seedTimer({ owner: "timekeeper" });
      const before = await readTimer(id);
      expect(statusOf(await confirmTimerAs(actor, id))).toBe(404);
      expect(await readTimer(id)).toEqual(before);
      await testDb.delete(timeTimers).where(eq(timeTimers.id, id));
    },
  );

  test("a colleague confirms only their own timer while the timekeeper's runs", async () => {
    const timekeeperTimer = await seedTimer({ owner: "timekeeper" });
    const colleagueTimer = await seedTimer({ owner: "colleague" });
    const before = await readTimer(timekeeperTimer);
    const result = await confirmTimerAs("colleague", colleagueTimer);
    expect(statusOf(result)).toBeNull();
    if (!("id" in result)) {
      throw new Error(`Timer confirmation failed: ${JSON.stringify(result)}`);
    }
    expect(await readTimer(colleagueTimer)).toBeUndefined();
    expect(await readEntry(result.id)).toMatchObject({
      userId: actors.colleague.userId,
      source: TIME_ENTRY_SOURCE.TIMER,
    });
    expect(await readTimer(timekeeperTimer)).toEqual(before);
    await testDb.delete(timeTimers).where(eq(timeTimers.id, timekeeperTimer));
  });

  test("the timekeeper can confirm their own timer", async () => {
    const id = await seedTimer({ owner: "timekeeper" });
    const result = await confirmTimerAs("timekeeper", id);
    expect(statusOf(result)).toBeNull();
    if (!("id" in result)) {
      throw new Error(`Timer confirmation failed: ${JSON.stringify(result)}`);
    }
    expect(await readTimer(id)).toBeUndefined();
    const entry = await readEntry(result.id);
    expect(entry).toMatchObject({
      userId: actors.timekeeper.userId,
      status: BILLING_STATUS.DRAFT,
    });
    expect(entry?.durationMinutes).toBeGreaterThan(0);
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
