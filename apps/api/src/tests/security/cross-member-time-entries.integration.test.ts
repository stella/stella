import { Result } from "better-result";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { Temporal } from "@stll/time";

import { member, organization, user } from "@/api/db/auth-schema";
import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  BILLING_STATUS,
  auditLogs,
  contacts,
  organizationSettings,
  entities,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeTimers,
  timeTimerConfirmations,
  workspaceMembers,
  workspaces,
  featureEnrolments,
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
import { loadFeatureAccessSnapshot } from "@/api/lib/auth/feature-access/context";
import { createSafeId, toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import {
  authorizedMemberRole,
  SESSION_CREDENTIAL,
} from "@/api/lib/permission-authorization";
import type { CredentialAuthority } from "@/api/lib/permission-authorization";
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
  await testDb.insert(user).values({
    id: userId,
    name,
    email: `${userId}@example.com`,
    emailVerified: true,
  });
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

  await testDb.insert(organizationSettings).values({
    id: createSafeId<"organizationSettings">(),
    organizationId,
    timeMinimumUnitMinutes: 15,
    timeNarrativeRequired: true,
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

  await testDb.insert(featureEnrolments).values(
    Object.values(actors).map(({ userId }) => ({
      organizationId,
      userId,
      featureId: "time-billing" as const,
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

type ActorContextOptions = {
  recordAuditEvent?: AuditRecorder;
  workspaceIds?: SafeId<"workspace">[];
  /** The credential behind the call; a person's session when omitted. */
  credential?: CredentialAuthority | undefined;
};
const contextFor = (
  name: ActorName,
  {
    recordAuditEvent = noopAuditRecorder,
    workspaceIds = [workspaceId],
    credential = SESSION_CREDENTIAL,
  }: ActorContextOptions = {},
) => {
  const actor = actors[name];
  return {
    createAuditRecorder: () => recordAuditEvent,
    getActiveWorkspaceIds: async () => workspaceIds,
    getAccessibleWorkspaces: async () =>
      workspaceIds.map((id) => ({ id, status: "active" as const })),
    getWorkspaceAccess: async (targetWorkspaceId: SafeId<"workspace">) =>
      workspaceIds.includes(targetWorkspaceId)
        ? { id: targetWorkspaceId, status: "active" as const }
        : null,
    memberRole: authorizedMemberRole({ role: actor.role, credential }),
    orgAIConfig: null,
    orgAIConfigStatus: ORG_AI_CONFIG_STATUS.ok,
    managedAIResidency: "eu" as const,
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
  run: (
    actor: ActorName,
    id: SafeId<"timeEntry">,
    credential?: CredentialAuthority,
  ) => Promise<unknown>;
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
    run: async (actor, id, credential) =>
      await updateTimeEntryById.handler(
        asTestRaw<UpdateCtx>({
          ...contextFor(actor, { credential }),
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
    run: async (actor, id, credential) =>
      await deleteTimeEntryById.handler(
        asTestRaw<DeleteCtx>({
          ...contextFor(actor, { credential }),
          body: { id },
        }),
      ),
    refusedStatus: 404,
    memberMayRunOnOwn: true,
    expectApplied: async (id) => {
      expect(await readEntry(id)).toBeNull();
    },
  },
  {
    name: "batch update",
    run: async (actor, id, credential) =>
      await batchUpdate.handler(
        asTestRaw<BatchUpdateCtx>({
          ...contextFor(actor, { credential }),
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
    run: async (actor, id, credential) =>
      await batchDelete.handler(
        asTestRaw<BatchDeleteCtx>({
          ...contextFor(actor, { credential }),
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
    run: async (actor, id, credential) =>
      await splitEntry.handler(
        asTestRaw<SplitCtx>({
          ...contextFor(actor, { credential }),
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

      test("an owner's key without the approve grant cannot change a member's entry", async () => {
        const id = await seedEntry({ owner: "timekeeper" });
        const before = await readEntry(id);

        const result = await operation.run("owner", id, {
          type: "attenuated",
          permissions: { timeEntry: ["read", "create", "update", "delete"] },
        });

        expect(statusOf(result)).toBe(operation.refusedStatus);
        expect(await readEntry(id)).toEqual(before);
      });

      test("an owner's key carrying the approve grant can", async () => {
        const id = await seedEntry({ owner: "timekeeper" });

        const result = await operation.run("owner", id, {
          type: "attenuated",
          permissions: {
            timeEntry: ["read", "create", "update", "delete", "approve"],
          },
        });

        expect(statusOf(result)).toBeNull();
        await operation.expectApplied(id);
      });

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

test("concurrent splits that read the same original create only one successor group", async () => {
  const id = await seedEntry({ owner: "owner" });
  const narrative = `Concurrent split ${id}`;
  await testDb
    .update(timeEntries)
    .set({ narrative })
    .where(eq(timeEntries.id, id));
  const snapshotsRead = Promise.withResolvers();
  let readCount = 0;
  const realSafeDb = asTestRaw<SafeDb>(contextFor("owner").safeDb);
  const safeDb: SafeDb = async (run, retry) => {
    const result = await realSafeDb(run, retry);
    if (
      result.isOk() &&
      typeof result.value === "object" &&
      result.value !== null &&
      "id" in result.value &&
      result.value.id === id
    ) {
      readCount += 1;
      if (readCount === 2) {
        snapshotsRead.resolve(undefined);
      }
      await snapshotsRead.promise;
    }
    return result;
  };
  const runSplit = async () =>
    await splitEntry.handler(
      asTestRaw<SplitCtx>({
        ...contextFor("owner"),
        safeDb,
        body: {
          id,
          splits: [
            { workItemId: workItemA, percentage: 50 },
            { workItemId: workItemB, percentage: 50 },
          ],
        },
      }),
    );
  const results = await Promise.all([runSplit(), runSplit()]);
  expect(readCount).toBe(2);
  expect(
    results.map(statusOf).toSorted((left, right) => (left ?? 0) - (right ?? 0)),
  ).toEqual([null, 409]);
  const successors = await testDb
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.narrative, narrative));
  expect(successors).toHaveLength(2);
  expect(new Set(successors.map((entry) => entry.splitGroupId)).size).toBe(1);
  expect(await readEntry(id)).toBeNull();
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
      ...contextFor(actor, {
        recordAuditEvent:
          actor === "admin" || actor === "owner"
            ? adminRecorder(actor)
            : noopAuditRecorder,
      }),
      params: { id },
      body: { narrative },
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
  await testDb
    .update(timeEntries)
    .set({ durationMinutes: 60, billedMinutes: 60 })
    .where(eq(timeEntries.id, entryId));
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
    response: { code: "running_timer" },
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
        billedMinutes: 15,
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
    await testDb
      .update(organizationSettings)
      .set({ timeNarrativeRequired: true })
      .where(eq(organizationSettings.organizationId, organizationId));
    const id = await seedTimer({ description: " " });
    const before = await readTimer(id);
    expect(await stopAs({ actor: "admin", id })).toMatchObject({
      code: 400,
      response: { code: "narrative_required" },
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

  test("optional policy records whether whitespace narrative was supplied by the admin", async () => {
    await testDb
      .update(organizationSettings)
      .set({ timeNarrativeRequired: false })
      .where(eq(organizationSettings.organizationId, organizationId));
    const suppliedId = await seedTimer({ description: null });
    const supplied = await stopAs({
      actor: "admin",
      id: suppliedId,
      narrative: " ",
    });
    if (!("id" in supplied)) {
      throw new Error(`Admin stop failed: ${JSON.stringify(supplied)}`);
    }
    expect(await readEntry(supplied.id)).toMatchObject({ narrative: " " });
    expect(
      await testDb.query.auditLogs.findFirst({
        where: { resourceId: { eq: suppliedId } },
      }),
    ).toMatchObject({
      changes: { narrativeFromAdmin: { old: null, new: true } },
    });
    const omittedId = await seedTimer({ description: null });
    const omitted = await stopAs({ actor: "admin", id: omittedId });
    if (!("id" in omitted)) {
      throw new Error(`Admin stop failed: ${JSON.stringify(omitted)}`);
    }
    expect(await readEntry(omitted.id)).toMatchObject({ narrative: "" });
    expect(
      await testDb.query.auditLogs.findFirst({
        where: { resourceId: { eq: omittedId } },
      }),
    ).toMatchObject({
      changes: { narrativeFromAdmin: { old: null, new: false } },
    });
    await testDb
      .update(organizationSettings)
      .set({ timeNarrativeRequired: true })
      .where(eq(organizationSettings.organizationId, organizationId));
  });

  test("a locked month refuses admin finalization without changing the timer or creating an entry", async () => {
    const id = await seedTimer();
    const before = await readTimer(id);
    const entriesBefore = await testDb
      .select()
      .from(timeEntries)
      .where(eq(timeEntries.organizationId, organizationId));
    await testDb
      .update(organizationSettings)
      .set({
        timeLockedThroughMonth: Temporal.PlainDate.from(today)
          .with({ day: 1 })
          .add({ months: 1 })
          .subtract({ days: 1 })
          .toString(),
      })
      .where(eq(organizationSettings.organizationId, organizationId));
    expect(await stopAs({ actor: "admin", id })).toMatchObject({
      code: 400,
      response: { code: "time_period_locked" },
    });
    expect(await readTimer(id)).toEqual(before);
    expect(
      await testDb
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.organizationId, organizationId)),
    ).toEqual(entriesBefore);
    expect(
      await testDb.select().from(auditLogs).where(eq(auditLogs.resourceId, id)),
    ).toHaveLength(0);
    await testDb
      .update(organizationSettings)
      .set({ timeLockedThroughMonth: null })
      .where(eq(organizationSettings.organizationId, organizationId));
    await testDb.delete(timeTimers).where(eq(timeTimers.id, id));
  });

  test("admin end refuses a matter the timekeeper can no longer access", async () => {
    const id = await seedTimer();
    const before = await readTimer(id);
    const membership = await testDb
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, actors.timekeeper.userId),
        ),
      )
      .returning();
    expect(membership).toHaveLength(1);
    expect(await stopAs({ actor: "admin", id })).toMatchObject({
      code: 404,
      response: { message: "Matter not found or not accessible" },
    });
    expect(await readTimer(id)).toEqual(before);
    expect(
      await testDb.select().from(auditLogs).where(eq(auditLogs.resourceId, id)),
    ).toHaveLength(0);
    await testDb.insert(workspaceMembers).values(membership);
    await testDb.delete(timeTimers).where(eq(timeTimers.id, id));
  });

  test("admin listing contains only running timers and omits descriptions", async () => {
    const runningId = await seedTimer();
    const pausedId = await seedTimer({ owner: "colleague", state: "paused" });
    const result = await adminListTimers.handler(
      asTestRaw<Parameters<typeof adminListTimers.handler>[0]>({
        ...contextFor("admin"),
        query: {},
      }),
    );
    if (!("items" in result)) {
      throw new Error(`Admin list failed: ${JSON.stringify(result)}`);
    }
    expect(result.items).toHaveLength(1);
    expect(result.items.at(0)).toMatchObject({
      id: runningId,
      ownerId: actors.timekeeper.userId,
      matterId: workspaceId,
    });
    expect(result.items.at(0)).not.toHaveProperty("description");
    await testDb.delete(timeTimers).where(eq(timeTimers.id, runningId));
    await testDb.delete(timeTimers).where(eq(timeTimers.id, pausedId));
  });

  test("admin listing hides an unstaffed clientless matter identifier", async () => {
    const hiddenMatterId = createSafeId<"workspace">();
    try {
      await testDb.insert(workspaces).values({
        id: hiddenMatterId,
        organizationId,
        name: "Private matter",
        reference: `PRIVATE-${hiddenMatterId}`,
        status: "active",
      });
      await testDb.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId: hiddenMatterId,
        userId: actors.timekeeper.userId,
      });
      const id = await seedTimer({ matterId: hiddenMatterId });
      const result = await adminListTimers.handler(
        asTestRaw<Parameters<typeof adminListTimers.handler>[0]>({
          ...contextFor("admin"),
          query: {},
        }),
      );
      if (!("items" in result)) {
        throw new Error(`Admin list failed: ${JSON.stringify(result)}`);
      }
      expect(result.items.find((item) => item.id === id)).toMatchObject({
        id,
        ownerId: actors.timekeeper.userId,
        matterId: null,
      });
    } finally {
      await testDb
        .delete(timeTimers)
        .where(eq(timeTimers.workspaceId, hiddenMatterId));
      await testDb.delete(workspaces).where(eq(workspaces.id, hiddenMatterId));
    }
  });

  test("admin listing exposes a client matter through firm-admin access without staffing", async () => {
    const clientId = createSafeId<"contact">();
    const clientMatterId = createSafeId<"workspace">();
    try {
      await testDb.insert(contacts).values({
        id: clientId,
        organizationId,
        type: "organization",
        displayName: "Client",
        organizationName: "Client",
      });
      await testDb.insert(workspaces).values({
        id: clientMatterId,
        organizationId,
        clientId,
        name: "Client matter",
        reference: `CLIENT-${clientMatterId}`,
        status: "active",
      });
      await testDb.insert(workspaceMembers).values({
        id: createSafeId<"workspaceMember">(),
        workspaceId: clientMatterId,
        userId: actors.timekeeper.userId,
      });
      const id = await seedTimer({ matterId: clientMatterId });
      const result = await adminListTimers.handler(
        asTestRaw<Parameters<typeof adminListTimers.handler>[0]>({
          ...contextFor("admin", {
            workspaceIds: [workspaceId, clientMatterId],
          }),
          query: {},
        }),
      );
      if (!("items" in result)) {
        throw new Error(`Admin list failed: ${JSON.stringify(result)}`);
      }
      expect(result.items.find((item) => item.id === id)).toMatchObject({
        id,
        ownerId: actors.timekeeper.userId,
        matterId: clientMatterId,
      });
    } finally {
      await testDb
        .delete(timeTimers)
        .where(eq(timeTimers.workspaceId, clientMatterId));
      await testDb.delete(workspaces).where(eq(workspaces.id, clientMatterId));
      await testDb.delete(contacts).where(eq(contacts.id, clientId));
    }
  });

  test("admin end uses the owner's timezone across the monthly lock boundary", async () => {
    try {
      setSystemTime(new Date("2026-10-01T01:00:00Z"));
      await testDb
        .update(user)
        .set({ timezoneId: "Pacific/Honolulu" })
        .where(eq(user.id, actors.timekeeper.userId));
      const id = await seedTimer();
      await testDb
        .update(timeTimers)
        .set({
          startedAt: new Date("2026-10-01T00:30:00Z"),
          lastResumedAt: new Date("2026-10-01T00:30:00Z"),
        })
        .where(eq(timeTimers.id, id));
      await testDb
        .update(organizationSettings)
        .set({ timeLockedThroughMonth: "2026-09-30" })
        .where(eq(organizationSettings.organizationId, organizationId));
      const before = await readTimer(id);
      const refused = await stopAs({ actor: "admin", id });
      expect(refused).toMatchObject({
        code: 400,
        response: { code: "time_period_locked" },
      });
      expect(await readTimer(id)).toEqual(before);
      await testDb
        .update(organizationSettings)
        .set({ timeLockedThroughMonth: null })
        .where(eq(organizationSettings.organizationId, organizationId));
      const result = await stopAs({ actor: "admin", id });
      if (statusOf(result) !== null || !("id" in result)) {
        throw new Error(`Admin stop failed: ${JSON.stringify(result)}`);
      }
      expect(await readEntry(result.id)).toMatchObject({
        userId: actors.timekeeper.userId,
        dateWorked: "2026-09-30",
        timezoneId: "Pacific/Honolulu",
        status: BILLING_STATUS.DRAFT,
      });
      expect(await readTimer(id)).toBeUndefined();
    } finally {
      await testDb
        .update(organizationSettings)
        .set({ timeLockedThroughMonth: null })
        .where(eq(organizationSettings.organizationId, organizationId));
      await testDb
        .update(user)
        .set({ timezoneId: "UTC" })
        .where(eq(user.id, actors.timekeeper.userId));
      await testDb
        .delete(timeTimers)
        .where(
          and(
            eq(timeTimers.organizationId, organizationId),
            eq(timeTimers.userId, actors.timekeeper.userId),
          ),
        );
      setSystemTime();
    }
  });

  test("admin end rolls back the draft, receipt and audit if the timer cannot be deleted", async () => {
    try {
      const id = await seedTimer({
        description: "Test refuse admin timer deletion",
      });
      const before = await readTimer(id);
      const entriesBefore = await testDb
        .select()
        .from(timeEntries)
        .where(eq(timeEntries.organizationId, organizationId));
      await testDb.execute(
        sql`CREATE FUNCTION test_refuse_admin_timer_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
      );
      await testDb.execute(
        sql`CREATE TRIGGER test_refuse_admin_timer_delete BEFORE DELETE ON time_timers FOR EACH ROW WHEN (OLD.description = 'Test refuse admin timer deletion') EXECUTE FUNCTION test_refuse_admin_timer_delete()`,
      );
      expect(await stopAs({ actor: "admin", id })).toMatchObject({ code: 409 });
      expect(await readTimer(id)).toEqual(before);
      expect(
        await testDb
          .select()
          .from(timeEntries)
          .where(eq(timeEntries.organizationId, organizationId)),
      ).toEqual(entriesBefore);
      expect(
        await testDb
          .select()
          .from(timeTimerConfirmations)
          .where(eq(timeTimerConfirmations.timerId, id)),
      ).toHaveLength(0);
      expect(
        await testDb
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.resourceId, id)),
      ).toHaveLength(0);
    } finally {
      await testDb.execute(
        sql`DROP TRIGGER IF EXISTS test_refuse_admin_timer_delete ON time_timers`,
      );
      await testDb.execute(
        sql`DROP FUNCTION IF EXISTS test_refuse_admin_timer_delete()`,
      );
      await testDb
        .delete(timeTimers)
        .where(
          and(
            eq(timeTimers.organizationId, organizationId),
            eq(timeTimers.description, "Test refuse admin timer deletion"),
          ),
        );
    }
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
    const hidden = await contextFor("colleague").safeDb((tx) =>
      tx.query.timeTimers.findFirst({ where: { id: { eq: id } } }),
    );
    expect(hidden.isOk()).toBe(true);
    if (hidden.isErr()) {
      throw new Error(
        `Timer visibility lookup failed: ${JSON.stringify(hidden.error)}`,
      );
    }
    expect(hidden.value).toBeUndefined();
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

const mcpContextFor = async (name: ActorName): Promise<McpRequestContext> => {
  const actor = actors[name];
  const workspaceIds = [workspaceId];
  const accessibleWorkspaces = workspaceIds.map((id) => ({
    id,
    status: "active" as const,
  }));
  const safeDb = asTestRaw<SafeDb>(
    createSafeDb(testDb, workspaceIds, organizationId, actor.userId),
  );
  const snapshot = await loadFeatureAccessSnapshot({
    safeDb,
    organizationId,
    userId: actor.userId,
  });
  if (Result.isError(snapshot)) {
    throw snapshot.error;
  }
  return asTestRaw<McpRequestContext>({
    featureAccessSnapshot: snapshot.value,
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
    userEmail: "standard@example.test",
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
          context: await mcpContextFor("colleague"),
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
            context: await mcpContextFor(actor),
            toolName: operation.toolName,
          });

          expect(result.isError).not.toBe(true);
          await operation.expectApplied(id);
        },
      );
    });
  }
});
