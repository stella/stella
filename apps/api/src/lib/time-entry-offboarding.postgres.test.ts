import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { SQLWrapper } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { member, organization, user } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import {
  auditLogs,
  BILLING_STATUS,
  organizationSettings,
  TIME_ENTRY_SOURCE,
  timeEntries,
  timeTimers,
  workspaceMembers,
  workspaces,
} from "@/api/db/schema";
import { createSafeDb, markRlsDatabase } from "@/api/db/scoped";
import { setSharedStatementTimeout } from "@/api/db/shared-pool-timeouts";
import { updateTimeEntryHandler } from "@/api/handlers/time-entries/update";
import { createAuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { cents } from "@/api/lib/money";
import { getPgErrorCode } from "@/api/lib/pg-error";
import { closeRemovedMemberActiveTimer } from "@/api/lib/time-entry-offboarding";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import {
  mintAuthProviderId,
  mintAuthProviderIdValue,
} from "@/api/tests/helpers/auth-provider-id";

const postgresDatabaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const TIMER_START = new Date("2026-01-15T10:00:00Z");
const WORK_DATE = "2026-01-15";
const CLOSED_MONTH = "2026-01-31";

const latch = () => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return { promise, release: () => resolve(undefined) };
};

const barrier = () => {
  const reached = latch();
  const released = latch();
  return {
    reached: reached.promise,
    release: released.release,
    wait: async () => {
      reached.release();
      await released.promise;
    },
  };
};
type Barrier = ReturnType<typeof barrier>;
const waitForBarrier = async (gate: Barrier, request: Promise<unknown>) =>
  await Promise.race([
    gate.reached,
    request.then((result) =>
      panic("Timer request finished before its transaction barrier", {
        result,
      }),
    ),
  ]);

type AdvisoryGateOptions = {
  kind: "helper_owner" | "update_owner";
  phase: "before_lock" | "after_lock";
};
const advisoryGate = ({ kind, phase }: AdvisoryGateOptions) => {
  const gate = barrier();
  const dialect = new PgDialect();
  let selected = false;
  const install = (tx: Transaction) => {
    const execute = tx.execute.bind(tx);
    // Retain the real driver's generic result and query object while
    // pausing execution at an actual advisory-lock statement.
    tx.execute = <TRow extends Record<string, unknown>>(
      query: SQLWrapper | string,
    ) => {
      const rendered =
        typeof query === "string"
          ? { sql: query, params: [] }
          : dialect.sqlToQuery(query.getSQL());
      const ownerQuery =
        rendered.sql.includes("pg_advisory_xact_lock") &&
        (kind === "helper_owner"
          ? rendered.params.some(
              (value) =>
                typeof value === "string" && value.startsWith("timer:"),
            )
          : rendered.sql.includes("owner_locks"));
      const raw = execute<TRow>(query);
      const executeRaw = raw.execute.bind(raw);
      raw.execute = async () => {
        const hold = ownerQuery && !selected;
        if (hold) {
          selected = true;
        }
        if (hold && phase === "before_lock") {
          await gate.wait();
        }
        const result = await executeRaw();
        if (hold && phase === "after_lock") {
          await gate.wait();
        }
        return result;
      };
      return raw;
    };
  };
  return { ...gate, install };
};

const seed = async (db: GatedTestDb) => {
  const organizationId = mintAuthProviderId<"organization">();
  const userId = mintAuthProviderId<"user">();
  const workspaceId = createSafeId<"workspace">();
  const entryId = createSafeId<"timeEntry">();
  const timerId = createSafeId<"timeTimer">();
  await db.insert(user).values({
    id: userId,
    name: "Timer policy fixture",
    email: `${userId}@timer-policy.test`,
  });
  await db.insert(organization).values({
    id: organizationId,
    name: "Timer policy fixture",
    slug: `timer-policy-${organizationId}`,
    createdAt: TIMER_START,
  });
  await db.insert(member).values({
    id: mintAuthProviderIdValue(),
    organizationId,
    userId,
    role: "owner",
    createdAt: TIMER_START,
  });
  await db.insert(workspaces).values({
    id: workspaceId,
    organizationId,
    name: "Timer policy fixture",
    reference: "TIMER-POLICY",
  });
  await db
    .insert(workspaceMembers)
    .values({ id: createSafeId<"workspaceMember">(), workspaceId, userId });
  await db.insert(organizationSettings).values({
    id: createSafeId<"organizationSettings">(),
    organizationId,
    timeLockedThroughMonth: null,
    timeMinimumUnitMinutes: 6,
    timeNarrativeRequired: false,
  });
  await db.insert(timeEntries).values({
    id: entryId,
    organizationId,
    workspaceId,
    userId,
    dateWorked: WORK_DATE,
    timezoneId: "UTC",
    durationMinutes: 1,
    billedMinutes: 6,
    rateAtEntry: cents(0),
    currency: "USD",
    narrative: "Recorded work",
    billable: false,
    status: BILLING_STATUS.DRAFT,
    source: TIME_ENTRY_SOURCE.TIMER,
    timerStartedAt: TIMER_START,
    timerStoppedAt: null,
  });
  // A paused linked clock fixes elapsed minutes independently of wall time.
  await db.insert(timeTimers).values({
    id: timerId,
    organizationId,
    workspaceId,
    userId,
    legacyTimeEntryId: entryId,
    state: "paused",
    accumulatedSeconds: 780,
    lastResumedAt: null,
    startedAt: TIMER_START,
    description: "Recorded work",
  });
  return { organizationId, userId, workspaceId, entryId, timerId };
};
type Fixture = Awaited<ReturnType<typeof seed>>;

type PolicyProbeOptions = { db: GatedTestDb; data: Fixture };
const assertPolicyProtected = async ({ db, data }: PolicyProbeOptions) => {
  const probe = await Result.tryPromise(
    async () =>
      await db.transaction(async (tx) => {
        await tx
          .select({ id: organizationSettings.id })
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, data.organizationId))
          .for("update", { noWait: true });
      }),
  );
  expect(probe.isErr()).toBe(true);
  expect(
    getPgErrorCode(probe.match({ ok: () => null, err: (cause) => cause })),
  ).toBe("55P03");
};

const readState = async ({ db, data }: PolicyProbeOptions) => ({
  entries: await db
    .select()
    .from(timeEntries)
    .where(eq(timeEntries.organizationId, data.organizationId)),
  clocks: await db
    .select()
    .from(timeTimers)
    .where(eq(timeTimers.organizationId, data.organizationId)),
  audits: await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.organizationId, data.organizationId)),
  settings: await db
    .select()
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, data.organizationId)),
});

type AssertClosedOptions = {
  state: Awaited<ReturnType<typeof readState>>;
  data: Fixture;
  oldDuration: number;
  oldBilled: number;
};
const assertClosed = ({
  state,
  data,
  oldDuration,
  oldBilled,
}: AssertClosedOptions) => {
  expect(state.entries).toHaveLength(1);
  const entry = state.entries.at(0);
  expect(entry).toMatchObject({
    id: data.entryId,
    status: BILLING_STATUS.DRAFT,
    dateWorked: WORK_DATE,
    durationMinutes: 13,
    billedMinutes: 18,
    timerStartedAt: null,
    timerStoppedAt: expect.any(Date),
  });
  expect(state.clocks).toHaveLength(1);
  expect(state.clocks.at(0)).toMatchObject({
    id: data.timerId,
    state: "paused",
    accumulatedSeconds: 780,
    lastResumedAt: null,
  });
  const serviceAudits = state.audits.filter(
    (row) => row.performerType === "service",
  );
  expect(serviceAudits).toHaveLength(1);
  expect(serviceAudits.at(0)).toMatchObject({
    action: "update",
    resourceType: "time_entry",
    resourceId: data.entryId,
    performerId: "organization-member-removal",
    workspaceId: data.workspaceId,
    metadata: { cause: "organization_member_removed" },
  });
  expect(serviceAudits.at(0)?.changes).toMatchObject({
    timerStartedAt: { old: TIMER_START.toISOString(), new: null },
    timerStoppedAt: { old: null, new: entry?.timerStoppedAt?.toISOString() },
    durationMinutes: { old: oldDuration, new: 13 },
    billedMinutes: { old: oldBilled, new: 18 },
  });
};

type PolicyOrderOptions = {
  databaseUrl: string;
  order: "timer_first" | "policy_first";
};
const runPolicyOrder = async ({ databaseUrl, order }: PolicyOrderOptions) => {
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const setup = openClient();
    const mutation = openClient();
    const policy = openClient();
    const data = await seed(setup.db);
    const start = barrier();
    const commit = barrier();
    const completion = mutation.db.transaction(async (tx) => {
      await setSharedStatementTimeout(tx, 5000);
      await start.wait();
      const outcome = await closeRemovedMemberActiveTimer({
        tx,
        organizationId: data.organizationId,
        userId: data.userId,
      });
      await commit.wait();
      return outcome;
    });
    try {
      await waitForBarrier(start, completion);
      if (order === "policy_first") {
        await policy.db
          .update(organizationSettings)
          .set({ timeLockedThroughMonth: CLOSED_MONTH })
          .where(eq(organizationSettings.organizationId, data.organizationId));
      }
      start.release();
      await waitForBarrier(commit, completion);
      await assertPolicyProtected({ db: policy.db, data });
      if (order === "timer_first") {
        const changing = policy.db.transaction(async (tx) => {
          await setSharedStatementTimeout(tx, 5000);
          await tx
            .update(organizationSettings)
            .set({ timeLockedThroughMonth: CLOSED_MONTH })
            .where(
              eq(organizationSettings.organizationId, data.organizationId),
            );
        });
        commit.release();
        const outcome = await completion;
        await changing;
        expect(outcome.isOk()).toBe(true);
        const state = await readState({ db: setup.db, data });
        expect(state.audits).toHaveLength(1);
        assertClosed({ state, data, oldDuration: 1, oldBilled: 6 });
      } else {
        commit.release();
        const outcome = await completion;
        expect(outcome.isErr()).toBe(true);
        expect(
          outcome.match({ ok: () => null, err: (error) => error }),
        ).toMatchObject({
          status: "BAD_REQUEST",
          body: {
            error: "time_period_locked",
            message:
              "The time period is locked. Move the locked-through month back before removing this member.",
          },
        });
        const state = await readState({ db: setup.db, data });
        expect(state.entries).toHaveLength(1);
        expect(state.entries.at(0)).toMatchObject({
          id: data.entryId,
          durationMinutes: 1,
          billedMinutes: 6,
          timerStartedAt: TIMER_START,
          timerStoppedAt: null,
        });
        expect(state.clocks).toHaveLength(1);
        expect(state.clocks.at(0)).toMatchObject({
          id: data.timerId,
          state: "paused",
          accumulatedSeconds: 780,
        });
        expect(state.audits).toEqual([]);
      }
      const settings = await setup.db
        .select()
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, data.organizationId));
      expect(settings.at(0)).toMatchObject({
        timeLockedThroughMonth: CLOSED_MONTH,
      });
    } finally {
      start.release();
      commit.release();
      try {
        await completion;
      } finally {
        await setup.db
          .delete(organization)
          .where(eq(organization.id, data.organizationId));
        await setup.db.delete(user).where(eq(user.id, data.userId));
      }
    }
  });
};

type UpdateRequestOptions = {
  db: GatedTestDb;
  data: Fixture;
  gate: ReturnType<typeof advisoryGate>;
  commit: Barrier;
};
const updateRequest = ({ db, data, gate, commit }: UpdateRequestOptions) => {
  const safeDb = createSafeDb(
    markRlsDatabase(db),
    [data.workspaceId],
    data.organizationId,
    data.userId,
  );
  let calls = 0;
  const gated: SafeDb = async (run) => {
    calls += 1;
    const write = calls === 3;
    return await safeDb(async (tx) => {
      await setSharedStatementTimeout(tx, 5000);
      if (write) {
        gate.install(tx);
      }
      const outcome = await run(tx);
      if (write) {
        await commit.wait();
      }
      return outcome;
    });
  };
  return Result.gen(() =>
    updateTimeEntryHandler({
      safeDb: gated,
      workspaceId: data.workspaceId,
      actor: { userId: data.userId, memberRole: { role: "owner" } },
      body: { id: data.entryId, durationMinutes: 19 },
      recordAuditEvent: createAuditRecorder({
        organizationId: data.organizationId,
        workspaceId: data.workspaceId,
        userId: data.userId,
        request: new Request("https://example.test/time-entries"),
        server: null,
      }),
    }),
  );
};

type UpdateOrderOptions = {
  databaseUrl: string;
  order: "timer_first" | "update_first";
};
const runUpdateOrder = async ({ databaseUrl, order }: UpdateOrderOptions) => {
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const setup = openClient();
    const mutation = openClient();
    const update = openClient();
    const data = await seed(setup.db);
    const helperOwner = advisoryGate({
      kind: "helper_owner",
      phase: order === "timer_first" ? "after_lock" : "before_lock",
    });
    const updateOwner = advisoryGate({
      kind: "update_owner",
      phase: "before_lock",
    });
    const updateCommit = barrier();
    const helperStart = barrier();
    const helperCommit = barrier();
    const helperSession = Promise.withResolvers<number>();
    const helper = mutation.db.transaction(async (tx) => {
      await setSharedStatementTimeout(tx, 5000);
      const sessions = await tx.execute<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const session =
        sessions.at(0) ?? panic("Timer fixture has no PostgreSQL backend");
      helperSession.resolve(session.pid);
      await helperStart.wait();
      helperOwner.install(tx);
      const outcome = await closeRemovedMemberActiveTimer({
        tx,
        organizationId: data.organizationId,
        userId: data.userId,
      });
      await helperCommit.wait();
      return outcome;
    });
    const request = updateRequest({
      db: update.db,
      data,
      gate: updateOwner,
      commit: updateCommit,
    });
    try {
      await Promise.all([
        waitForBarrier(helperStart, helper),
        waitForBarrier(updateOwner, request),
      ]);
      if (order === "update_first") {
        updateOwner.release();
        await waitForBarrier(updateCommit, request);
      }
      helperStart.release();
      await waitForBarrier(helperOwner, helper);
      const helperPid = await helperSession.promise;
      const locks = await setup.sql<{ policyBeforeOwner: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM pg_locks
          WHERE pid = ${helperPid}
            AND relation = 'organization_settings'::regclass
            AND mode = 'RowShareLock'
            AND granted
        ) AS "policyBeforeOwner"
      `;
      expect(locks.at(0)).toEqual({ policyBeforeOwner: true });
      // The first held owner lock must not imply a matter lock yet.
      if (order === "timer_first") {
        const probes = await setup.sql.begin(
          async (tx) =>
            await tx<{ ownerAvailable: boolean; matterAvailable: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext(${`timer:${data.organizationId}:${data.userId}`})) AS "ownerAvailable",
                 pg_try_advisory_xact_lock(hashtext(${data.workspaceId})) AS "matterAvailable"
        `,
        );
        expect(probes.at(0)).toEqual({
          ownerAvailable: false,
          matterAvailable: true,
        });
      }
      helperOwner.release();
      if (order === "update_first") {
        updateCommit.release();
      } else {
        updateOwner.release();
      }
      await waitForBarrier(helperCommit, helper);
      helperCommit.release();
      await waitForBarrier(updateCommit, request);
      updateCommit.release();
      const [closed, updated] = await Promise.all([helper, request]);
      expect(closed.isOk()).toBe(true);
      const state = await readState({ db: setup.db, data });
      if (order === "timer_first") {
        expect(updated.isErr()).toBe(true);
        expect(
          updated.match({ ok: () => null, err: (error) => error }),
        ).toMatchObject({
          status: 409,
          message: "Time entry changed; reload and try again",
        });
        expect(state.audits).toHaveLength(1);
        assertClosed({ state, data, oldDuration: 1, oldBilled: 6 });
      } else {
        expect(updated.isOk()).toBe(true);
        expect(state.audits).toHaveLength(2);
        assertClosed({ state, data, oldDuration: 19, oldBilled: 24 });
        expect(
          state.audits.find((row) => row.performerType === "user")?.changes,
        ).toMatchObject({
          durationMinutes: { old: 1, new: 19 },
          billedMinutes: { old: 6, new: 24 },
        });
      }
    } finally {
      helperStart.release();
      helperOwner.release();
      helperCommit.release();
      updateOwner.release();
      updateCommit.release();
      try {
        const outcomes = await Promise.allSettled([helper, request]);
        const failures = outcomes
          .filter((outcome) => outcome.status === "rejected")
          .map((outcome) => outcome.reason);
        if (failures.length > 0) {
          panic("Concurrent timer requests failed", { failures });
        }
      } finally {
        await setup.db
          .delete(organization)
          .where(eq(organization.id, data.organizationId));
        await setup.db.delete(user).where(eq(user.id, data.userId));
      }
    }
  });
};

if (!postgresDatabaseUrl || !runPostgresTests) {
  describe.skip("member removal timer policy ordering (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("member removal timer policy ordering (postgres)", () => {
    for (const order of ["timer_first", "policy_first"] as const) {
      test(`member timer closure follows the policy committed first (${order})`, async () => {
        await runPolicyOrder({ databaseUrl: postgresDatabaseUrl, order });
      }, 30_000);
    }
    for (const order of ["timer_first", "update_first"] as const) {
      test(`member timer closure and entry update share one lock order (${order})`, async () => {
        await runUpdateOrder({ databaseUrl: postgresDatabaseUrl, order });
      }, 30_000);
    }
  });
}
