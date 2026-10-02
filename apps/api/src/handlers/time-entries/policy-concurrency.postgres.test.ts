import { Err, panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { ElysiaCustomStatusResponse } from "elysia/error";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  BILLING_STATUS,
  entities,
  organizationSettings,
  timeEntries,
  TIME_ENTRY_SOURCE,
  timeTimers,
  timeTimerConfirmations,
  workspaces,
  workspaceMembers,
} from "@/api/db/schema";
import { createSafeDb, createScopedDb, markRlsDatabase } from "@/api/db/scoped";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import batchDelete from "@/api/handlers/time-entries/batch/delete";
import batchUpdate from "@/api/handlers/time-entries/batch/update";
import { deleteTimeEntryHandler } from "@/api/handlers/time-entries/delete";
import splitEntry from "@/api/handlers/time-entries/split";
import { updateTimeEntryHandler } from "@/api/handlers/time-entries/update";
import { finalizeTimer } from "@/api/handlers/time-timers/finalize";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createTimeEntryHandler } from "@/api/lib/billing/time-entry-insert";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const postgresDatabaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const OPERATIONS = [
  "create",
  "move_in",
  "move_out",
  "duration",
  "delete",
  "split",
  "batch_delete",
  "batch_update",
] as const;
type Operation = (typeof OPERATIONS)[number];
const TRANSITIONS = ["month", "minimum_unit", "narrative"] as const;
type Transition = (typeof TRANSITIONS)[number];
const ORDERS = ["mutation_first", "policy_first"] as const;
type Order = (typeof ORDERS)[number];

// The selected transaction follows all preflight reads. Keeping this total
// makes adding an operation require an explicit interleaving decision.
const WRITE_TRANSACTION = {
  create: 3,
  move_in: 3,
  move_out: 3,
  duration: 3,
  delete: 3,
  split: 4,
  batch_delete: 1,
  batch_update: 1,
} as const satisfies Record<Operation, number>;

const latch = () => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return { promise, release: () => resolve(undefined) };
};

type TransactionGateOptions = {
  safeDb: SafeDb;
  transaction: number;
  phase: "before_write" | "before_commit";
};
const transactionGate = ({
  safeDb,
  transaction,
  phase,
}: TransactionGateOptions) => {
  const reached = latch();
  const released = latch();
  let calls = 0;
  const gated: SafeDb = async (run) => {
    calls += 1;
    const selected = calls === transaction;
    if (selected && phase === "before_write") {
      reached.release();
      await released.promise;
    }
    return await safeDb(async (tx) => {
      await setSharedStatementTimeout(tx, 5000);
      const result = await run(tx);
      if (selected && phase === "before_commit") {
        reached.release();
        await released.promise;
      }
      return result;
    });
  };
  return { safeDb: gated, reached: reached.promise, release: released.release };
};

type Gate = { reached: Promise<undefined>; release: () => void };
const waitForGate = async (gate: Gate, operation: Promise<unknown>) =>
  await Promise.race([
    gate.reached,
    operation.then((result) =>
      panic("Entry request finished before its transaction barrier", {
        result,
      }),
    ),
  ]);

type AssertPolicyProtectedOptions = { db: GatedTestDb; data: Fixture };
const assertPolicyProtected = async ({
  db,
  data,
}: AssertPolicyProtectedOptions) => {
  const attemptedLock = await Result.tryPromise(
    async () =>
      await db.transaction(async (tx) => {
        await tx
          .select({ id: organizationSettings.id })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, data.organizationId))
          .for("update", { noWait: true });
      }),
  );
  expect(attemptedLock.isErr()).toBe(true);
  const error = attemptedLock.match({ ok: () => null, err: (cause) => cause });
  expect(getPgErrorCode(error)).toBe("55P03");
};

const matterLockGate = (phase: "before_lock" | "after_lock") => {
  const reached = latch();
  const released = latch();
  const dialect = new PgDialect();
  let held = false;
  const install = (transaction: Transaction) => {
    const execute = transaction.execute.bind(transaction);
    // Preserve the driver's generic result and query object; only its
    // execution waits at the requested real PostgreSQL lock boundary.
    transaction.execute = <TRow extends Record<string, unknown>>(
      query: SQLWrapper | string,
    ) => {
      const rendered =
        typeof query === "string"
          ? { sql: query, params: [] }
          : dialect.sqlToQuery(query.getSQL());
      const matters =
        rendered.sql.includes("pg_advisory_xact_lock") &&
        !rendered.params.some(
          (value) => typeof value === "string" && value.startsWith("timer:"),
        );
      const raw = execute<TRow>(query);
      const executeRaw = raw.execute.bind(raw);
      raw.execute = async () => {
        const selected = matters && !held;
        if (selected) {
          held = true;
        }
        if (selected && phase === "before_lock") {
          reached.release();
          await released.promise;
        }
        const result = await executeRaw();
        if (selected && phase === "after_lock") {
          reached.release();
          await released.promise;
        }
        return result;
      };
      return raw;
    };
    const openSavepoint = transaction.transaction.bind(transaction);
    transaction.transaction = async (run) =>
      await openSavepoint(async (savepoint) => {
        install(savepoint);
        return await run(savepoint);
      });
  };
  return { reached: reached.promise, release: released.release, install };
};

const fixture = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const entryId = createSafeId<"timeEntry">();
  const firstWorkItemId = createSafeId<"entity">();
  const secondWorkItemId = createSafeId<"entity">();
  await db.insert(user).values({
    id: userId,
    name: "Time policy fixture",
    email: `${userId}@time-policy.test`,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: "Time policy fixture",
    slug: `time-policy-${organizationId}`,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Time policy fixture",
    reference: "TIME-POLICY",
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  await db.insert(workspaceMembers).values({
    id: createSafeId<"workspaceMember">(),
    workspaceId,
    userId,
  });
  await db.insert(entities).values([
    { id: firstWorkItemId, workspaceId, name: "First work item" },
    { id: secondWorkItemId, workspaceId, name: "Second work item" },
  ]);
  await db.insert(organizationSettings).values({
    id: createSafeId<"organizationSettings">(),
    organizationId,
    timeMinimumUnitMinutes: 6,
    timeNarrativeRequired: false,
    timeLockedThroughMonth: null,
  });
  const recordAuditEvent = createAuditRecorder({
    organizationId,
    workspaceId,
    userId,
    request: new Request("https://example.test/time-entries"),
    server: null,
  });
  return {
    organizationId,
    userId,
    workspaceId,
    entryId,
    firstWorkItemId,
    secondWorkItemId,
    recordAuditEvent,
    actor: { userId, memberRole: { role: "owner" as const } },
  };
};
type Fixture = Awaited<ReturnType<typeof fixture>>;

type SeedEntryOptions = {
  db: GatedTestDb;
  data: Fixture;
  operation: Operation;
};
const seedEntry = async ({ db, data, operation }: SeedEntryOptions) => {
  if (operation === "create") {
    return;
  }
  await db.insert(timeEntries).values({
    id: data.entryId,
    organizationId: data.organizationId,
    workspaceId: data.workspaceId,
    userId: data.userId,
    workItemId: data.firstWorkItemId,
    dateWorked: operation === "move_in" ? "2026-02-01" : "2026-01-15",
    timezoneId: "UTC",
    durationMinutes: 13,
    billedMinutes: 18,
    rateAtEntry: cents(0),
    currency: "USD",
    narrative: "",
    billable: false,
    status: BILLING_STATUS.DRAFT,
  });
};

type RunEntryOptions = {
  operation: Operation;
  data: Fixture;
  safeDb: SafeDb;
  db: GatedTestDb;
};
const runEntry = async ({ operation, data, safeDb, db }: RunEntryOptions) => {
  const shared = {
    safeDb,
    workspaceId: data.workspaceId,
    actor: data.actor,
    recordAuditEvent: data.recordAuditEvent,
  };
  switch (operation) {
    case "create":
      return await Result.gen(() =>
        createTimeEntryHandler({
          ...shared,
          organizationId: data.organizationId,
          userId: data.userId,
          memberRole: data.actor.memberRole,
          body: {
            dateWorked: "2026-01-15",
            timezoneId: "UTC",
            durationMinutes: 13,
            narrative: "",
            billable: false,
          },
        }),
      );
    case "move_in":
    case "move_out":
      return await Result.gen(() =>
        updateTimeEntryHandler({
          ...shared,
          body: {
            id: data.entryId,
            dateWorked: operation === "move_in" ? "2026-01-15" : "2026-02-01",
            timezoneId: "UTC",
          },
        }),
      );
    case "duration":
      return await Result.gen(() =>
        updateTimeEntryHandler({
          ...shared,
          body: { id: data.entryId, durationMinutes: 19 },
        }),
      );
    case "delete":
      return await Result.gen(() =>
        deleteTimeEntryHandler({ ...shared, body: { id: data.entryId } }),
      );
    case "split":
      return await splitEntry.handler(
        asTestRaw<Parameters<typeof splitEntry.handler>[0]>({
          ...shared,
          session: { activeOrganizationId: data.organizationId },
          user: { id: data.userId },
          memberRole: data.actor.memberRole,
          request: new Request("https://example.test/time-entries/split", {
            method: "POST",
          }),
          route: "/time-entries/split",
          scopedDb: createScopedDb(
            markRlsDatabase(db),
            [data.workspaceId],
            data.organizationId,
            data.userId,
          ),
          body: {
            id: data.entryId,
            splits: [
              { workItemId: data.firstWorkItemId, percentage: 50 },
              { workItemId: data.secondWorkItemId, percentage: 50 },
            ],
          },
        }),
      );
    case "batch_delete":
      return await batchDelete.handler(
        asTestRaw<Parameters<typeof batchDelete.handler>[0]>({
          ...shared,
          session: { activeOrganizationId: data.organizationId },
          user: { id: data.userId },
          memberRole: data.actor.memberRole,
          request: new Request("https://example.test/time-entries/batch", {
            method: "DELETE",
          }),
          route: "/time-entries/batch",
          scopedDb: createScopedDb(
            markRlsDatabase(db),
            [data.workspaceId],
            data.organizationId,
            data.userId,
          ),
          body: { ids: [data.entryId] },
        }),
      );
    case "batch_update":
      return await batchUpdate.handler(
        asTestRaw<Parameters<typeof batchUpdate.handler>[0]>({
          ...shared,
          session: { activeOrganizationId: data.organizationId },
          user: { id: data.userId },
          memberRole: data.actor.memberRole,
          request: new Request("https://example.test/time-entries/batch", {
            method: "PATCH",
          }),
          route: "/time-entries/batch",
          scopedDb: createScopedDb(
            markRlsDatabase(db),
            [data.workspaceId],
            data.organizationId,
            data.userId,
          ),
          body: { ids: [data.entryId], action: "approve" },
        }),
      );
    default: {
      const exhaustive: never = operation;
      return panic("Unknown policy test operation", { exhaustive });
    }
  }
};

const refusal = (result: Awaited<ReturnType<typeof runEntry>>) => {
  if (result instanceof Err) {
    return result.error;
  }
  if (result instanceof ElysiaCustomStatusResponse) {
    return { status: result.code, ...result.response };
  }
  return null;
};

const policyUpdate = (transition: Transition) => {
  switch (transition) {
    case "month":
      return { timeLockedThroughMonth: "2026-01-31" };
    case "minimum_unit":
      return { timeMinimumUnitMinutes: 15 };
    case "narrative":
      return { timeNarrativeRequired: true };
    default: {
      const exhaustive: never = transition;
      return panic("Unknown policy test transition", { exhaustive });
    }
  }
};

type AssertOutcomeOptions = {
  db: GatedTestDb;
  data: Fixture;
  operation: Operation;
  transition: Transition;
  order: Order;
  result: Awaited<ReturnType<typeof runEntry>>;
};
const assertOutcome = async ({
  db,
  data,
  operation,
  transition,
  order,
  result,
}: AssertOutcomeOptions) => {
  const rows = await db
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.workspaceId, data.workspaceId));
  const audits = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.workspaceId, data.workspaceId));
  const shouldRefuse =
    order === "policy_first" &&
    (transition === "month" ||
      (transition === "narrative" &&
        operation !== "delete" &&
        operation !== "batch_delete"));
  if (shouldRefuse) {
    expect(refusal(result)).toMatchObject({
      status: 400,
      code:
        transition === "month" ? "time_period_locked" : "narrative_required",
      message:
        transition === "month"
          ? "The time period is locked"
          : "A narrative is required for time entries",
    });
    expect(audits).toEqual([]);
    if (operation === "create") {
      expect(rows).toEqual([]);
      return;
    }
    expect(rows).toHaveLength(1);
    expect(rows.at(0)).toMatchObject({
      id: data.entryId,
      dateWorked: operation === "move_in" ? "2026-02-01" : "2026-01-15",
      durationMinutes: 13,
      billedMinutes: 18,
      narrative: "",
      status: BILLING_STATUS.DRAFT,
    });
    return;
  }
  expect(refusal(result)).toBeNull();
  const minimumUnit =
    transition === "minimum_unit" && order === "policy_first" ? 15 : 6;
  switch (operation) {
    case "delete":
    case "batch_delete":
      expect(rows).toEqual([]);
      expect(audits).toHaveLength(1);
      expect(audits.at(0)).toMatchObject({
        action: "delete",
        resourceId: data.entryId,
      });
      break;
    case "split":
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.durationMinutes).toSorted()).toEqual([6, 7]);
      expect(rows.map((row) => row.billedMinutes).toSorted()).toEqual(
        minimumUnit === 15 ? [15, 15] : [6, 12],
      );
      expect(
        rows.every(
          (row) =>
            row.dateWorked === "2026-01-15" &&
            row.narrative === "" &&
            row.status === BILLING_STATUS.DRAFT,
        ),
      ).toBe(true);
      expect(audits).toHaveLength(3);
      expect(audits.filter((row) => row.action === "create")).toHaveLength(2);
      expect(audits.find((row) => row.action === "delete")).toMatchObject({
        resourceId: data.entryId,
      });
      break;
    case "create":
      expect(rows).toHaveLength(1);
      expect(rows.at(0)).toMatchObject({
        durationMinutes: 13,
        billedMinutes: minimumUnit === 15 ? 15 : 18,
        dateWorked: "2026-01-15",
        narrative: "",
      });
      expect(audits).toHaveLength(1);
      expect(audits.at(0)).toMatchObject({
        action: "create",
        resourceId: rows.at(0)?.id,
      });
      expect(audits.at(0)?.changes).toMatchObject({
        created: { new: { billedMinutes: minimumUnit === 15 ? 15 : 18 } },
      });
      break;
    case "duration":
      expect(rows).toHaveLength(1);
      expect(rows.at(0)).toMatchObject({
        id: data.entryId,
        durationMinutes: 19,
        billedMinutes: minimumUnit === 15 ? 30 : 24,
      });
      expect(audits).toHaveLength(1);
      expect(audits.at(0)?.changes).toMatchObject({
        durationMinutes: { old: 13, new: 19 },
        billedMinutes: { old: 18, new: minimumUnit === 15 ? 30 : 24 },
      });
      break;
    case "move_in":
    case "move_out":
      expect(rows).toHaveLength(1);
      expect(rows.at(0)).toMatchObject({
        id: data.entryId,
        durationMinutes: 13,
        billedMinutes: minimumUnit === 15 ? 15 : 18,
        dateWorked: operation === "move_in" ? "2026-01-15" : "2026-02-01",
      });
      expect(audits).toHaveLength(1);
      expect(audits.at(0)?.changes).toMatchObject({
        dateWorked: {
          old: operation === "move_in" ? "2026-02-01" : "2026-01-15",
          new: operation === "move_in" ? "2026-01-15" : "2026-02-01",
        },
      });
      break;
    case "batch_update":
      expect(rows).toHaveLength(1);
      expect(rows.at(0)).toMatchObject({
        id: data.entryId,
        durationMinutes: 13,
        billedMinutes: minimumUnit === 15 ? 15 : 18,
        status: BILLING_STATUS.APPROVED,
        approvedByUserId: data.userId,
      });
      expect(audits).toHaveLength(1);
      expect(audits.at(0)?.changes).toMatchObject({
        status: { old: BILLING_STATUS.DRAFT, new: BILLING_STATUS.APPROVED },
      });
      break;
    default: {
      const exhaustive: never = operation;
      panic("Unknown policy test assertion", { exhaustive });
    }
  }
};

const SAME_STATUS_OPERATIONS = [
  "delete",
  "duration",
  "split",
  "batch_delete",
  "batch_update",
] as const satisfies readonly Operation[];
type SameStatusOperation = (typeof SAME_STATUS_OPERATIONS)[number];
type SameStatusOptions = {
  databaseUrl: string;
  operation: SameStatusOperation;
};
const runSameStatusEdit = async ({
  databaseUrl,
  operation,
}: SameStatusOptions) => {
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const setup = openClient();
    const mutation = openClient();
    const data = await fixture(setup.db);
    try {
      await seedEntry({ db: setup.db, data, operation });
      const safeDb = createSafeDb(
        markRlsDatabase(mutation.db),
        [data.workspaceId],
        data.organizationId,
        data.userId,
      );
      const gate = transactionGate({
        safeDb,
        transaction: WRITE_TRANSACTION[operation],
        phase: "before_write",
      });
      const protectedGate = transactionGate({
        safeDb: gate.safeDb,
        transaction: WRITE_TRANSACTION[operation],
        phase: "before_commit",
      });
      const request = runEntry({
        operation,
        data,
        safeDb: protectedGate.safeDb,
        db: mutation.db,
      });
      try {
        await waitForGate(gate, request);
        // Preserve status and updatedAt: the snapshot must come from the row
        // under lock even when those two fields alone cannot detect an edit.
        await setup.db
          .update(timeEntries)
          .set({
            durationMinutes: 31,
            billedMinutes: 36,
            narrative: "Concurrent work",
          })
          .where(eq(timeEntries.id, data.entryId));
        gate.release();
        await waitForGate(protectedGate, request);
        await assertPolicyProtected({ db: setup.db, data });
        protectedGate.release();
        const result = await request;
        const rows = await setup.db
          .select()
          .from(timeEntries)
          .where(eq(timeEntries.workspaceId, data.workspaceId));
        const audits = await setup.db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.workspaceId, data.workspaceId));
        switch (operation) {
          case "duration":
            expect(refusal(result)).toMatchObject({
              status: 409,
              message: "Time entry changed; reload and try again",
            });
            expect(rows).toHaveLength(1);
            expect(rows.at(0)).toMatchObject({
              durationMinutes: 31,
              billedMinutes: 36,
              narrative: "Concurrent work",
              status: BILLING_STATUS.DRAFT,
            });
            expect(audits).toEqual([]);
            break;
          case "delete":
          case "batch_delete":
            expect(refusal(result)).toBeNull();
            expect(rows).toEqual([]);
            expect(audits).toHaveLength(1);
            expect(audits.at(0)?.changes).toMatchObject({
              deleted: {
                old: {
                  dateWorked: "2026-01-15",
                  durationMinutes: 31,
                  billedMinutes: 36,
                  workItemId: data.firstWorkItemId,
                  currency: "USD",
                  billable: false,
                },
                new: null,
              },
            });
            break;
          case "split":
            expect(refusal(result)).toBeNull();
            expect(rows).toHaveLength(2);
            expect(rows.map((row) => row.durationMinutes).toSorted()).toEqual([
              15, 16,
            ]);
            expect(rows.map((row) => row.billedMinutes)).toEqual([18, 18]);
            expect(
              rows.every((row) => row.narrative === "Concurrent work"),
            ).toBe(true);
            expect(audits).toHaveLength(3);
            expect(
              audits.find((row) => row.action === "delete")?.changes,
            ).toMatchObject({
              deleted: { old: { durationMinutes: 31, billedMinutes: 36 } },
            });
            break;
          case "batch_update":
            expect(refusal(result)).toBeNull();
            expect(rows).toHaveLength(1);
            expect(rows.at(0)).toMatchObject({
              durationMinutes: 31,
              billedMinutes: 36,
              narrative: "Concurrent work",
              status: BILLING_STATUS.APPROVED,
            });
            expect(audits).toHaveLength(1);
            expect(audits.at(0)?.changes).toMatchObject({
              status: {
                old: BILLING_STATUS.DRAFT,
                new: BILLING_STATUS.APPROVED,
              },
            });
            break;
          default: {
            const exhaustive: never = operation;
            panic("Unknown same-status test operation", { exhaustive });
          }
        }
      } finally {
        gate.release();
        protectedGate.release();
        await request;
      }
    } finally {
      await setup.db
        .delete(organization)
        .where(eq(organization.id, data.organizationId));
      await setup.db.delete(user).where(eq(user.id, data.userId));
    }
  });
};

const runOpposingTimers = async (databaseUrl: string) => {
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const setup = openClient();
    const first = openClient();
    const second = openClient();
    const data = await fixture(setup.db);
    const secondUserId = mintAuthProviderId<"user">();
    const secondWorkspaceId = createSafeId<"workspace">();
    const secondEntryId = createSafeId<"timeEntry">();
    const firstTimerId = createSafeId<"timeTimer">();
    const secondTimerId = createSafeId<"timeTimer">();
    try {
      await seedEntry({ db: setup.db, data, operation: "duration" });
      await setup.db
        .update(timeEntries)
        .set({ source: TIME_ENTRY_SOURCE.TIMER })
        .where(eq(timeEntries.id, data.entryId));
      await setup.db.insert(user).values({
        id: secondUserId,
        name: "Second timekeeper",
        email: `${secondUserId}@time-policy.test`,
      });
      await setup.db.insert(member).values({
        id: mintAuthProviderIdValue(),
        organizationId: data.organizationId,
        userId: secondUserId,
        role: "owner",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      });
      await setup.db.insert(workspaces).values({
        id: secondWorkspaceId,
        organizationId: data.organizationId,
        name: "Second matter",
        reference: "TIME-POLICY-SECOND",
      });
      await setup.db.insert(workspaceMembers).values([
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId: data.workspaceId,
          userId: secondUserId,
        },
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId: secondWorkspaceId,
          userId: data.userId,
        },
        {
          id: createSafeId<"workspaceMember">(),
          workspaceId: secondWorkspaceId,
          userId: secondUserId,
        },
      ]);
      await setup.db.insert(timeEntries).values({
        id: secondEntryId,
        organizationId: data.organizationId,
        workspaceId: secondWorkspaceId,
        userId: secondUserId,
        dateWorked: "2026-01-15",
        timezoneId: "UTC",
        durationMinutes: 13,
        billedMinutes: 18,
        rateAtEntry: cents(0),
        currency: "USD",
        narrative: "Second recorded work",
        billable: false,
        source: TIME_ENTRY_SOURCE.TIMER,
      });
      await setup.db.insert(timeTimers).values([
        {
          id: firstTimerId,
          organizationId: data.organizationId,
          userId: data.userId,
          workspaceId: secondWorkspaceId,
          legacyTimeEntryId: data.entryId,
          state: "paused",
          accumulatedSeconds: 780,
          startedAt: new Date("2026-01-15T10:00:00Z"),
          lastResumedAt: null,
          description: "First recorded work",
        },
        {
          id: secondTimerId,
          organizationId: data.organizationId,
          userId: secondUserId,
          workspaceId: data.workspaceId,
          legacyTimeEntryId: secondEntryId,
          state: "paused",
          accumulatedSeconds: 780,
          startedAt: new Date("2026-01-15T10:00:00Z"),
          lastResumedAt: null,
          description: "Second recorded work",
        },
      ]);
      const firstGate = transactionGate({
        safeDb: createSafeDb(
          markRlsDatabase(first.db),
          [data.workspaceId, secondWorkspaceId],
          data.organizationId,
          data.userId,
        ),
        transaction: 1,
        phase: "before_write",
      });
      const secondGate = transactionGate({
        safeDb: createSafeDb(
          markRlsDatabase(second.db),
          [data.workspaceId, secondWorkspaceId],
          data.organizationId,
          secondUserId,
        ),
        transaction: 1,
        phase: "before_write",
      });
      const firstLock = matterLockGate("after_lock");
      const secondLock = matterLockGate("before_lock");
      const firstCompletion = firstGate.safeDb(async (tx) => {
        firstLock.install(tx);
        return await finalizeTimer({
          tx,
          owner: { organizationId: data.organizationId, userId: data.userId },
          id: firstTimerId,
          memberRole: data.actor.memberRole,
          recordAuditEvent: data.recordAuditEvent,
          completion: { type: "owner", timezoneId: "UTC", billable: false },
        });
      });
      const secondCompletion = secondGate.safeDb(async (tx) => {
        secondLock.install(tx);
        return await finalizeTimer({
          tx,
          owner: { organizationId: data.organizationId, userId: secondUserId },
          id: secondTimerId,
          memberRole: data.actor.memberRole,
          recordAuditEvent: createAuditRecorder({
            organizationId: data.organizationId,
            workspaceId: secondWorkspaceId,
            userId: secondUserId,
            request: new Request("https://example.test/time-timers/confirm"),
            server: null,
          }),
          completion: { type: "owner", timezoneId: "UTC", billable: false },
        });
      });
      try {
        await Promise.all([
          waitForGate(firstGate, firstCompletion),
          waitForGate(secondGate, secondCompletion),
        ]);
        firstGate.release();
        await waitForGate(firstLock, firstCompletion);
        const probes = await setup.sql.begin(
          async (tx) =>
            await tx<
              {
                firstAvailable: boolean;
                secondAvailable: boolean;
                firstKey: number;
                secondKey: number;
              }[]
            >`
          SELECT hashtext(${data.workspaceId}) AS "firstKey", hashtext(${secondWorkspaceId}) AS "secondKey",
                 pg_try_advisory_xact_lock(hashtext(${data.workspaceId})) AS "firstAvailable",
                 pg_try_advisory_xact_lock(hashtext(${secondWorkspaceId})) AS "secondAvailable"
        `,
        );
        expect(probes.at(0)?.firstKey).not.toBe(probes.at(0)?.secondKey);
        expect(probes.at(0)).toMatchObject({
          firstAvailable: false,
          secondAvailable: false,
        });
        await assertPolicyProtected({ db: setup.db, data });
        secondGate.release();
        await waitForGate(secondLock, secondCompletion);
        secondLock.release();
        firstLock.release();
        const [firstResult, secondResult] = await Promise.all([
          firstCompletion,
          secondCompletion,
        ]);
        expect(firstResult.isOk()).toBe(true);
        expect(secondResult.isOk()).toBe(true);
        const firstOutcome = firstResult.unwrap();
        const secondOutcome = secondResult.unwrap();
        expect(firstOutcome.isOk()).toBe(true);
        expect(secondOutcome.isOk()).toBe(true);
        const firstReceipt = firstOutcome.unwrap();
        const secondReceipt = secondOutcome.unwrap();
        const rows = await setup.db
          .select()
          .from(timeEntries)
          .where(eq(timeEntries.organizationId, data.organizationId));
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === firstReceipt.id)).toMatchObject({
          workspaceId: secondWorkspaceId,
          userId: data.userId,
          durationMinutes: 13,
          billedMinutes: 18,
        });
        expect(rows.find((row) => row.id === secondReceipt.id)).toMatchObject({
          workspaceId: data.workspaceId,
          userId: secondUserId,
          durationMinutes: 13,
          billedMinutes: 18,
        });
        expect(
          await setup.db
            .select()
            .from(timeTimers)
            .where(eq(timeTimers.organizationId, data.organizationId)),
        ).toEqual([]);
        const confirmations = await setup.db
          .select()
          .from(timeTimerConfirmations)
          .where(
            eq(timeTimerConfirmations.organizationId, data.organizationId),
          );
        expect(confirmations).toHaveLength(2);
        const audits = await setup.db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.organizationId, data.organizationId));
        expect(
          audits.filter(
            (row) =>
              row.resourceType === "time_timer" && row.action === "delete",
          ),
        ).toHaveLength(2);
        expect(
          audits.filter(
            (row) =>
              row.resourceType === "time_entry" && row.action === "create",
          ),
        ).toHaveLength(2);
        expect(
          audits
            .filter(
              (row) =>
                row.resourceType === "time_entry" && row.action === "delete",
            )
            .map((row) => row.resourceId)
            .toSorted(),
        ).toEqual([data.entryId, secondEntryId].toSorted());
      } finally {
        firstGate.release();
        secondGate.release();
        firstLock.release();
        secondLock.release();
        await Promise.all([firstCompletion, secondCompletion]);
      }
    } finally {
      await setup.db
        .delete(organization)
        .where(eq(organization.id, data.organizationId));
      await setup.db
        .delete(user)
        .where(inArray(user.id, [data.userId, secondUserId]));
    }
  });
};

type RunOrderOptions = {
  databaseUrl: string;
  operation: Operation;
  transition: Transition;
  order: Order;
};
const runOrder = async ({
  databaseUrl,
  operation,
  transition,
  order,
}: RunOrderOptions) => {
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const setup = openClient();
    const mutation = openClient();
    const policy = openClient();
    const data = await fixture(setup.db);
    try {
      await seedEntry({ db: setup.db, data, operation });
      const safeDb = createSafeDb(
        markRlsDatabase(mutation.db),
        [data.workspaceId],
        data.organizationId,
        data.userId,
      );
      const gate = transactionGate({
        safeDb,
        transaction: WRITE_TRANSACTION[operation],
        phase: order === "policy_first" ? "before_write" : "before_commit",
      });
      const request = runEntry({
        operation,
        data,
        safeDb: gate.safeDb,
        db: mutation.db,
      });
      try {
        await waitForGate(gate, request);
        if (order === "mutation_first") {
          // NOWAIT proves the mutation protects the decisive policy row even
          // when this transition does not affect deletion's business rules.
          await assertPolicyProtected({ db: policy.db, data });
          const entered = latch();
          const changed = policy.db.transaction(async (tx) => {
            entered.release();
            await tx
              .update(organizationSettings)
              .set(policyUpdate(transition))
              .where(
                eq(organizationSettings.organizationId, data.organizationId),
              );
          });
          await entered.promise;
          gate.release();
          const result = await request;
          await changed;
          await assertOutcome({
            db: setup.db,
            data,
            operation,
            transition,
            order,
            result,
          });
        } else {
          await policy.db
            .update(organizationSettings)
            .set(policyUpdate(transition))
            .where(
              eq(organizationSettings.organizationId, data.organizationId),
            );
          gate.release();
          await assertOutcome({
            db: setup.db,
            data,
            operation,
            transition,
            order,
            result: await request,
          });
        }
        const settings = await setup.db
          .select()
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, data.organizationId));
        expect(settings.at(0)).toMatchObject(policyUpdate(transition));
      } finally {
        gate.release();
        await request;
      }
    } finally {
      await setup.db
        .delete(organization)
        .where(eq(organization.id, data.organizationId));
      await setup.db.delete(user).where(eq(user.id, data.userId));
    }
  });
};

if (!postgresDatabaseUrl || !runPostgresTests) {
  describe.skip("time entry policy ordering (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("time entry policy ordering (postgres)", () => {
    for (const operation of OPERATIONS) {
      for (const transition of TRANSITIONS) {
        test(`${operation} uses the policy committed before its write (${transition})`, async () => {
          for (const order of ORDERS) {
            await runOrder({
              databaseUrl: postgresDatabaseUrl,
              operation,
              transition,
              order,
            });
          }
        }, 30_000);
      }
    }
    for (const operation of SAME_STATUS_OPERATIONS) {
      test(`${operation} preserves the current row in its audit or refuses a same-status edit`, async () => {
        await runSameStatusEdit({
          databaseUrl: postgresDatabaseUrl,
          operation,
        });
      }, 30_000);
    }
    test("timers reassigned to opposing matters both complete", async () => {
      await runOpposingTimers(postgresDatabaseUrl);
    }, 30_000);
  });
}
