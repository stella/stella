import { panic } from "better-result";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import * as v from "valibot";

import type { AgentHarness } from "@stll/api-contract/agent-harness";
import {
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  type DesktopRunnerDesktopMessage,
  type DesktopRunnerHarnessReport,
  desktopRunnerHarnessReportSchema,
} from "@stll/api-contract/desktop-runner";

import type { RootDatabase, Transaction } from "@/api/db/root";
import {
  desktopRunnerCommands,
  desktopRunnerEvents,
  desktopRunnerRuns,
  desktopRunners,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  withAggregateTransaction,
  withSkipLockedBatch,
} from "@/api/lib/db/aggregate-lock";
import {
  transitionLifecycle,
  transitionLifecycleBatch,
} from "@/api/lib/db/transitions";
import { DESKTOP_RUNNER_RUN_TRANSITIONS } from "@/api/lib/desktop-runner/run-transitions";
import {
  DESKTOP_RUNNER_LEASED_RUN_STATES,
  DESKTOP_RUNNER_OPEN_RUN_STATES,
  type DesktopRunnerCommandKind,
  type DesktopRunnerRunState,
} from "@/api/lib/desktop-runner/states";
import { brandPersistedWorkspaceId } from "@/api/lib/safe-id-boundaries";

/**
 * The gateway's persistence. Postgres is the truth for what a desktop holds:
 * a socket's memory only caches it, so any API task can take over a desktop
 * after a reconnect. Every write is conditional on the state it expects, so a
 * retried or raced call converges instead of applying twice.
 */
export type DesktopRunnerDb = Pick<
  RootDatabase,
  "select" | "insert" | "update" | "transaction"
>;

/** Who a socket belongs to: the credential's account and the device key. */
export type RunnerBinding = {
  readonly userId: SafeId<"user">;
  readonly organizationId: SafeId<"organization">;
  readonly desktopId: string;
  readonly deviceJkt: string;
};

const runner = desktopRunners;
const runs = desktopRunnerRuns;

const runnerKey = ({ userId, organizationId, desktopId }: RunnerBinding) =>
  and(
    eq(runner.userId, userId),
    eq(runner.organizationId, organizationId),
    eq(runner.desktopId, desktopId),
  );

/** A run belongs to a socket only through the same desktop and device key. */
const boundTo = ({
  userId,
  organizationId,
  desktopId,
  deviceJkt,
}: RunnerBinding) =>
  and(
    eq(runs.userId, userId),
    eq(runs.organizationId, organizationId),
    eq(runs.desktopId, desktopId),
    eq(runs.deviceJkt, deviceJkt),
  );

const leaseUntil = (now: Date, leaseMs: number) =>
  new Date(now.getTime() + leaseMs);

/** Every condition must hold; a run write is always bound to its socket. */
const guarded = (...conditions: (SQL | undefined)[]): SQL =>
  and(...conditions) ?? panic("A desktop runner write needs its conditions");

/** Records the moment a run was accepted, keeping the first one. */
const acceptedNow = (now: Date) =>
  sql`coalesce(${runs.acceptedAt}, ${now}::timestamptz)`;

// Run states are socket bookkeeping; the caller that starts a run audits it.
const skipRunAudit = async () => await Promise.resolve();

/** `hello` lists at most this many held runs, by the wire contract. */
const MAX_HELD_RUNS = 64;

const harnessReportsSchema = v.array(desktopRunnerHarnessReportSchema);

/** Reports are validated before they are stored; a stored one that fails is corruption. */
const storedHarnessReports = (value: unknown): DesktopRunnerHarnessReport[] => {
  const parsed = v.safeParse(harnessReportsSchema, value);
  return parsed.success
    ? parsed.output
    : panic("A stored desktop runner harness report no longer validates");
};

type HelloMessage = Extract<
  DesktopRunnerDesktopMessage,
  { type: typeof DESKTOP_RUNNER_DESKTOP_MESSAGE.hello }
>;

type ClaimSessionOptions = {
  binding: RunnerBinding;
  sessionId: string;
  instanceId: string;
  hello: HelloMessage;
  now: Date;
  leaseMs: number;
};

export type HeldRun = {
  readonly runId: string;
  readonly state: DesktopRunnerRunState;
  readonly ackSeq: number;
  readonly workspaceIds: readonly SafeId<"workspace">[];
};

type ClaimSessionResult = {
  /** The socket this one replaces, to be told it is no longer current. */
  previous: { sessionId: string; instanceId: string } | null;
  /** The runs the desktop listed that are bound to it, after reconciling. */
  held: HeldRun[];
};

/**
 * Make this socket the desktop's current one and reconcile its runs with what
 * the desktop says it holds: a held open run is running again, an unaccepted
 * one it does not hold is offered again, and an accepted one it does not hold
 * is lost.
 */
export const claimRunnerSession = async (
  db: DesktopRunnerDb,
  { binding, sessionId, instanceId, hello, now, leaseMs }: ClaimSessionOptions,
): Promise<ClaimSessionResult> =>
  await withAggregateTransaction(db, async (tx) => {
    const [existing] = await tx
      .select({
        sessionId: runner.sessionId,
        instanceId: runner.instanceId,
        connection: runner.connection,
      })
      .from(runner)
      .where(runnerKey(binding))
      .limit(1);
    const values = {
      deviceJkt: binding.deviceJkt,
      sessionId,
      instanceId,
      connection: "connected" as const,
      protocol: hello.protocol,
      appVersion: hello.appVersion,
      sidecarVersion: hello.sidecarVersion,
      harnesses: hello.harnesses,
      connectedAt: now,
      lastSeenAt: now,
    };
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    await tx
      .insert(runner)
      .values({
        userId: binding.userId,
        organizationId: binding.organizationId,
        desktopId: binding.desktopId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [runner.userId, runner.organizationId, runner.desktopId],
        set: values,
      });
    const heldIds = new Set(hello.activeRuns.map(({ runId }) => runId));
    const openIds = (
      await tx
        .select({ runId: runs.runId })
        .from(runs)
        .where(
          and(
            boundTo(binding),
            inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
          ),
        )
    ).map(({ runId }) => runId);
    const stillHeld = openIds.filter((runId) => heldIds.has(runId));
    const away = openIds.filter((runId) => !heldIds.has(runId));
    const lease = leaseUntil(now, leaseMs);
    await transitionLifecycleBatch({
      tx,
      spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
      ids: stillHeld,
      moves: { state: { from: DESKTOP_RUNNER_OPEN_RUN_STATES, to: "running" } },
      guard: guarded(boundTo(binding)),
      set: {
        acceptedAt: acceptedNow(now),
        leaseExpiresAt: lease,
        updatedAt: now,
      },
      recordTransitionAuditEvent: skipRunAudit,
    });
    await transitionLifecycleBatch({
      tx,
      spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
      ids: away,
      moves: {
        state: { from: ["assigned", "waiting_for_computer"], to: "assigned" },
      },
      guard: guarded(boundTo(binding), isNull(runs.acceptedAt)),
      set: { leaseExpiresAt: lease, updatedAt: now },
      recordTransitionAuditEvent: skipRunAudit,
    });
    await transitionLifecycleBatch({
      tx,
      spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
      ids: away,
      moves: {
        state: { from: ["running", "waiting_for_computer"], to: "lost" },
      },
      guard: guarded(boundTo(binding), isNotNull(runs.acceptedAt)),
      set: { updatedAt: now },
      recordTransitionAuditEvent: skipRunAudit,
    });
    const held = await tx
      .select({
        runId: runs.runId,
        state: runs.state,
        ackSeq: runs.ackSeq,
        workspaceIds: runs.workspaceIds,
      })
      .from(runs)
      .where(and(boundTo(binding), inArray(runs.runId, [...heldIds])))
      .orderBy(asc(runs.runId))
      .limit(MAX_HELD_RUNS);
    return {
      previous:
        existing === undefined ||
        existing.connection === "disconnected" ||
        existing.sessionId === sessionId
          ? null
          : { sessionId: existing.sessionId, instanceId: existing.instanceId },
      held: held.map((row) => ({
        ...row,
        workspaceIds: row.workspaceIds.map(brandPersistedWorkspaceId),
      })),
    };
  });

type SessionOptions = { binding: RunnerBinding; sessionId: string };

/** Record that a socket closed, unless a newer one already took over. */
export const releaseRunnerSession = async (
  db: DesktopRunnerDb,
  { binding, sessionId }: SessionOptions,
) => {
  // audit: skip - runner socket bookkeeping; the run's caller audits the work
  await db
    .update(runner)
    .set({ connection: "disconnected" })
    .where(and(runnerKey(binding), eq(runner.sessionId, sessionId)));
};

type RenewOptions = SessionOptions & { now: Date; leaseMs: number };

/**
 * A heartbeat of the current socket: the runner is seen, and every open run it
 * holds keeps its lease. A run whose lease lapsed while the socket stayed open
 * returns to the state it had. Returns `false` when this socket is no longer
 * the desktop's current one.
 */
export const renewRunnerSession = async (
  db: DesktopRunnerDb,
  { binding, sessionId, now, leaseMs }: RenewOptions,
): Promise<boolean> =>
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    const seen = await tx
      .update(runner)
      .set({ lastSeenAt: now })
      .where(and(runnerKey(binding), eq(runner.sessionId, sessionId)))
      .returning({ sessionId: runner.sessionId });
    if (seen.length === 0) {
      return false;
    }
    const lapsed = (
      await tx
        .select({ runId: runs.runId })
        .from(runs)
        .where(and(boundTo(binding), eq(runs.state, "waiting_for_computer")))
    ).map(({ runId }) => runId);
    const lease = leaseUntil(now, leaseMs);
    await transitionLifecycleBatch({
      tx,
      spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
      ids: lapsed,
      moves: { state: { from: ["waiting_for_computer"], to: "assigned" } },
      guard: guarded(boundTo(binding), isNull(runs.acceptedAt)),
      set: { leaseExpiresAt: lease, updatedAt: now },
      recordTransitionAuditEvent: skipRunAudit,
    });
    await transitionLifecycleBatch({
      tx,
      spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
      ids: lapsed,
      moves: { state: { from: ["waiting_for_computer"], to: "running" } },
      guard: guarded(boundTo(binding), isNotNull(runs.acceptedAt)),
      set: { leaseExpiresAt: lease, updatedAt: now },
      recordTransitionAuditEvent: skipRunAudit,
    });
    await tx
      .update(runs)
      .set({ leaseExpiresAt: lease, updatedAt: now })
      .where(
        and(
          boundTo(binding),
          inArray(runs.state, DESKTOP_RUNNER_LEASED_RUN_STATES),
        ),
      );
    return true;
  });

type HarnessStatusOptions = SessionOptions & {
  report: DesktopRunnerHarnessReport;
};

/** Replace one harness's report; returns `false` when the socket is not current. */
export const recordHarnessStatus = async (
  db: DesktopRunnerDb,
  { binding, sessionId, report }: HarnessStatusOptions,
): Promise<boolean> =>
  await withAggregateTransaction(db, async (tx) => {
    const current = and(runnerKey(binding), eq(runner.sessionId, sessionId));
    const [row] = await tx
      .select({ harnesses: runner.harnesses })
      .from(runner)
      .where(current)
      .limit(1);
    if (row === undefined) {
      return false;
    }
    const harnesses = [
      ...storedHarnessReports(row.harnesses).filter(
        ({ id }) => id !== report.id,
      ),
      report,
    ];
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    await tx.update(runner).set({ harnesses }).where(current);
    return true;
  });

type RunTransitionOptions = {
  binding: RunnerBinding;
  runId: string;
  now: Date;
  leaseMs: number;
};

/** What a run message did to its run, from the socket's point of view. */
export type RunTransition =
  | { type: "applied" }
  | { type: "unknown_run" }
  | { type: "invalid_state"; state: DesktopRunnerRunState };

const readBoundRun = async (
  tx: Transaction,
  binding: RunnerBinding,
  runId: string,
) =>
  (
    await tx
      .select({
        state: runs.state,
        ackSeq: runs.ackSeq,
        acceptedAt: runs.acceptedAt,
      })
      .from(runs)
      .where(and(boundTo(binding), eq(runs.runId, runId)))
      .limit(1)
  ).at(0);

/** The desktop started the run; repeating it changes nothing. */
export const recordRunAccepted = async (
  db: DesktopRunnerDb,
  { binding, runId, now, leaseMs }: RunTransitionOptions,
): Promise<RunTransition> =>
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    const accepted = await transitionLifecycle({
      tx,
      spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
      id: runId,
      moves: { state: { from: DESKTOP_RUNNER_OPEN_RUN_STATES, to: "running" } },
      guard: guarded(boundTo(binding)),
      set: {
        acceptedAt: acceptedNow(now),
        leaseExpiresAt: leaseUntil(now, leaseMs),
        updatedAt: now,
      },
      recordTransitionAuditEvent: skipRunAudit,
    });
    if (accepted.type === "transitioned") {
      return { type: "applied" };
    }
    const run = await readBoundRun(tx, binding, runId);
    return run === undefined
      ? { type: "unknown_run" }
      : { type: "invalid_state", state: run.state };
  });

type RunRejectedOptions = Omit<RunTransitionOptions, "leaseMs"> & {
  reason: Extract<
    DesktopRunnerDesktopMessage,
    { type: typeof DESKTOP_RUNNER_DESKTOP_MESSAGE.runRejected }
  >["reason"];
};

/** The desktop refused a run it never accepted; repeating it changes nothing. */
export const recordRunRejected = async (
  db: DesktopRunnerDb,
  { binding, runId, reason, now }: RunRejectedOptions,
): Promise<RunTransition> =>
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    const rejected = await transitionLifecycle({
      tx,
      spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
      id: runId,
      moves: {
        state: { from: ["assigned", "waiting_for_computer"], to: "rejected" },
      },
      guard: guarded(boundTo(binding), isNull(runs.acceptedAt)),
      set: { rejectReason: reason, updatedAt: now },
      recordTransitionAuditEvent: skipRunAudit,
    });
    if (rejected.type === "transitioned") {
      return { type: "applied" };
    }
    const run = await readBoundRun(tx, binding, runId);
    if (run === undefined) {
      return { type: "unknown_run" };
    }
    return run.state === "rejected"
      ? { type: "applied" }
      : { type: "invalid_state", state: run.state };
  });

export type SequencedRunMessage = Extract<
  DesktopRunnerDesktopMessage,
  {
    type:
      | typeof DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent
      | typeof DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest
      | typeof DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished;
  }
>;

/** What persisting one sequenced run message did. */
export type PersistedRunMessage =
  | { type: "persisted"; seq: number }
  | { type: "duplicate"; ackSeq: number }
  | { type: "gap"; ackSeq: number }
  | { type: "unknown_run" }
  | { type: "invalid_state"; state: DesktopRunnerRunState };

/** Run states that accept the next sequenced message. */
const SEQUENCED_RUN_STATES = [
  "running",
  "waiting_for_computer",
] as const satisfies readonly DesktopRunnerRunState[];

type AdvanceOptions = {
  tx: Transaction;
  binding: RunnerBinding;
  message: SequencedRunMessage;
  now: Date;
  leaseMs: number;
};

/**
 * Advance a run's acknowledged position by one. A message proves the desktop
 * accepted the run; `run.finished` ends it, anything else keeps it running.
 */
const advanceRun = async ({
  tx,
  binding,
  message,
  now,
  leaseMs,
}: AdvanceOptions) => {
  const guard = guarded(boundTo(binding), eq(runs.ackSeq, message.seq - 1));
  const advanced = {
    ackSeq: message.seq,
    acceptedAt: acceptedNow(now),
    leaseExpiresAt: leaseUntil(now, leaseMs),
    updatedAt: now,
  };
  switch (message.type) {
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished:
      return await transitionLifecycle({
        tx,
        spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
        id: message.runId,
        moves: { state: { from: SEQUENCED_RUN_STATES, to: "finished" } },
        guard,
        set: {
          ...advanced,
          outcome: message.outcome,
          harnessSessionId: message.harnessSessionId,
        },
        recordTransitionAuditEvent: skipRunAudit,
      });
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent:
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest:
      return await transitionLifecycle({
        tx,
        spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
        id: message.runId,
        moves: { state: { from: SEQUENCED_RUN_STATES, to: "running" } },
        guard,
        set: advanced,
        recordTransitionAuditEvent: skipRunAudit,
      });
    default: {
      message satisfies never;
      return panic("Unknown sequenced desktop runner message");
    }
  }
};

type PersistRunMessageOptions = {
  binding: RunnerBinding;
  message: SequencedRunMessage;
  now: Date;
  leaseMs: number;
};

/**
 * Store the next message of a run and advance its acknowledged position in
 * one transaction. Positions advance one at a time, so the stored log never
 * has a hole; a position already stored is a duplicate and changes nothing.
 */
export const persistRunMessage = async (
  db: DesktopRunnerDb,
  { binding, message, now, leaseMs }: PersistRunMessageOptions,
): Promise<PersistedRunMessage> =>
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    const advanced = await advanceRun({ tx, binding, message, now, leaseMs });
    if (advanced.type === "transitioned") {
      await tx.insert(desktopRunnerEvents).values({
        runId: message.runId,
        seq: message.seq,
        type: message.type,
        requestId:
          message.type === DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest
            ? message.requestId
            : null,
        message,
      });
      return { type: "persisted", seq: message.seq };
    }
    const run = await readBoundRun(tx, binding, message.runId);
    if (run === undefined) {
      return { type: "unknown_run" };
    }
    if (message.seq <= run.ackSeq) {
      return { type: "duplicate", ackSeq: run.ackSeq };
    }
    if (message.seq > run.ackSeq + 1) {
      return { type: "gap", ackSeq: run.ackSeq };
    }
    return { type: "invalid_state", state: run.state };
  });

type ExpireLeasesOptions = { now: Date; limit: number };

/**
 * Move runs whose lease lapsed to `waiting_for_computer`. They stay bound to
 * their desktop; rows another task is expiring are skipped, not waited on.
 */
export const expireRunLeases = async (
  db: DesktopRunnerDb,
  { now, limit }: ExpireLeasesOptions,
): Promise<string[]> =>
  await withSkipLockedBatch({
    database: db,
    limit,
    select: (tx) =>
      tx
        .select({ runId: runs.runId })
        .from(runs)
        .where(
          and(
            inArray(runs.state, DESKTOP_RUNNER_LEASED_RUN_STATES),
            sql`${runs.leaseExpiresAt} <= ${now}::timestamptz`,
          ),
        )
        .orderBy(asc(runs.leaseExpiresAt))
        .limit(limit)
        .$dynamic(),
    run: async (tx, rows) => {
      if (rows.length === 0) {
        return [];
      }
      // audit: skip - runner socket bookkeeping; the run's caller audits the work
      return await transitionLifecycleBatch({
        tx,
        spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
        ids: rows.map(({ runId }) => runId),
        moves: {
          state: {
            from: DESKTOP_RUNNER_LEASED_RUN_STATES,
            to: "waiting_for_computer",
          },
        },
        set: { updatedAt: now },
        recordTransitionAuditEvent: skipRunAudit,
      });
    },
  });

export type PendingCommand = {
  readonly id: number;
  readonly runId: string;
  readonly kind: DesktopRunnerCommandKind;
  readonly payload: unknown;
  readonly workspaceIds: readonly SafeId<"workspace">[];
};

type PendingCommandsOptions = SessionOptions & {
  afterId: number;
  limit: number;
};

type PendingCommandsResult =
  { type: "current"; commands: PendingCommand[] } | { type: "superseded" };

/**
 * Commands queued after `afterId` for the open runs bound to this socket, in
 * queue order. A socket that is no longer the desktop's current one gets none.
 */
export const readPendingCommands = async (
  db: DesktopRunnerDb,
  { binding, sessionId, afterId, limit }: PendingCommandsOptions,
): Promise<PendingCommandsResult> => {
  const [current] = await db
    .select({ sessionId: runner.sessionId })
    .from(runner)
    .where(and(runnerKey(binding), eq(runner.sessionId, sessionId)))
    .limit(1);
  if (current === undefined) {
    return { type: "superseded" };
  }
  const rows = await db
    .select({
      id: desktopRunnerCommands.id,
      runId: desktopRunnerCommands.runId,
      kind: desktopRunnerCommands.kind,
      payload: desktopRunnerCommands.payload,
      workspaceIds: runs.workspaceIds,
    })
    .from(desktopRunnerCommands)
    .innerJoin(runs, eq(runs.runId, desktopRunnerCommands.runId))
    .where(
      and(
        boundTo(binding),
        inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
        gt(desktopRunnerCommands.id, afterId),
      ),
    )
    .orderBy(asc(desktopRunnerCommands.id))
    .limit(limit);
  return {
    type: "current",
    commands: rows.map((row) => ({
      ...row,
      workspaceIds: row.workspaceIds.map(brandPersistedWorkspaceId),
    })),
  };
};

type ReadyRunnersOptions = {
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
  seenSince: Date;
  limit: number;
};

export type ConnectedRunner = {
  readonly desktopId: string;
  readonly deviceJkt: string;
  readonly sessionId: string;
  readonly instanceId: string;
  readonly lastSeenAt: Date;
  readonly harnesses: readonly DesktopRunnerHarnessReport[];
};

/** A member's connected runners seen since `seenSince`, most recent first. */
export const readConnectedRunners = async (
  db: Pick<DesktopRunnerDb, "select">,
  { userId, organizationId, seenSince, limit }: ReadyRunnersOptions,
): Promise<ConnectedRunner[]> => {
  const rows = await db
    .select({
      desktopId: runner.desktopId,
      deviceJkt: runner.deviceJkt,
      sessionId: runner.sessionId,
      instanceId: runner.instanceId,
      lastSeenAt: runner.lastSeenAt,
      harnesses: runner.harnesses,
    })
    .from(runner)
    .where(
      and(
        eq(runner.userId, userId),
        eq(runner.organizationId, organizationId),
        eq(runner.connection, "connected"),
        sql`${runner.lastSeenAt} >= ${seenSince}::timestamptz`,
      ),
    )
    .orderBy(desc(runner.lastSeenAt), asc(runner.desktopId))
    .limit(limit);
  return rows.map((row) => ({
    ...row,
    harnesses: storedHarnessReports(row.harnesses),
  }));
};

export type RunOwner = {
  readonly userId: SafeId<"user">;
  readonly organizationId: SafeId<"organization">;
};

type InsertRunOptions = {
  owner: RunOwner;
  runId: string;
  desktopId: string;
  harness: AgentHarness;
  harnessVersion: string;
  model: string;
  workspaceIds: readonly SafeId<"workspace">[];
  payload: object;
  now: Date;
  leaseMs: number;
  seenSince: Date;
};

/** Where an assigned run's doorbell rings. */
export type RunHolder = {
  readonly sessionId: string;
  readonly instanceId: string;
};

export type InsertedRun =
  | { type: "assigned"; holder: RunHolder }
  | { type: "duplicate" }
  | { type: "conflict" }
  | { type: "no_computer" }
  | {
      type: "harness_unavailable";
      report: DesktopRunnerHarnessReport | null;
    }
  | { type: "model_unavailable" };

/**
 * Bind a new run to a connected runner and queue its `run.start`, both or
 * neither. The runner must report the harness ready at the requested version
 * with the requested model. The run id is the idempotency key: assigning it
 * again to the same desktop is a duplicate, to another one a conflict.
 */
export const insertAssignedRun = async (
  db: DesktopRunnerDb,
  options: InsertRunOptions,
): Promise<InsertedRun> =>
  await withAggregateTransaction(db, async (tx) => {
    const { owner, runId, desktopId, harness, harnessVersion, now } = options;
    const [existingRun] = await tx
      .select({
        userId: runs.userId,
        organizationId: runs.organizationId,
        desktopId: runs.desktopId,
      })
      .from(runs)
      .where(eq(runs.runId, runId))
      .limit(1);
    if (existingRun !== undefined) {
      return existingRun.userId === owner.userId &&
        existingRun.organizationId === owner.organizationId &&
        existingRun.desktopId === desktopId
        ? { type: "duplicate" }
        : { type: "conflict" };
    }
    const [target] = await tx
      .select({
        deviceJkt: runner.deviceJkt,
        sessionId: runner.sessionId,
        instanceId: runner.instanceId,
        harnesses: runner.harnesses,
      })
      .from(runner)
      .where(
        and(
          eq(runner.userId, owner.userId),
          eq(runner.organizationId, owner.organizationId),
          eq(runner.desktopId, desktopId),
          eq(runner.connection, "connected"),
          sql`${runner.lastSeenAt} >= ${options.seenSince}::timestamptz`,
        ),
      )
      .limit(1);
    if (target === undefined) {
      return { type: "no_computer" };
    }
    const report =
      storedHarnessReports(target.harnesses).find(({ id }) => id === harness) ??
      null;
    if (report?.state !== "ready" || report.version !== harnessVersion) {
      return { type: "harness_unavailable", report };
    }
    if (!report.models.some(({ id }) => id === options.model)) {
      return { type: "model_unavailable" };
    }
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    const inserted = await tx
      .insert(runs)
      .values({
        runId,
        userId: owner.userId,
        organizationId: owner.organizationId,
        desktopId,
        deviceJkt: target.deviceJkt,
        harness,
        harnessVersion,
        workspaceIds: [...options.workspaceIds],
        state: "assigned",
        leaseExpiresAt: leaseUntil(now, options.leaseMs),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ runId: runs.runId });
    if (inserted.length === 0) {
      return { type: "duplicate" };
    }
    await tx.insert(desktopRunnerCommands).values({
      runId,
      kind: "run.start",
      commandKey: runId,
      payload: options.payload,
    });
    return {
      type: "assigned",
      holder: { sessionId: target.sessionId, instanceId: target.instanceId },
    };
  });

type InsertCommandOptions = {
  owner: RunOwner;
  runId: string;
  kind: Exclude<DesktopRunnerCommandKind, "run.start">;
  commandKey: string;
  payload: object;
  /** An approval answer names a request the run made. */
  answersRequestId: string | null;
};

export type InsertedCommand =
  | { type: "queued"; holder: RunHolder | null }
  | { type: "duplicate" }
  | { type: "run_not_found" }
  | { type: "run_ended"; state: DesktopRunnerRunState }
  | { type: "approval_not_requested" };

/**
 * Queue one command for an open run of `owner`. The command key makes a
 * repeat a duplicate; the holder is returned only while its socket is open.
 */
export const insertRunCommand = async (
  db: DesktopRunnerDb,
  options: InsertCommandOptions,
): Promise<InsertedCommand> =>
  await withAggregateTransaction(db, async (tx) => {
    const { owner, runId } = options;
    const [run] = await tx
      .select({
        state: runs.state,
        sessionId: runner.sessionId,
        instanceId: runner.instanceId,
        connection: runner.connection,
      })
      .from(runs)
      .innerJoin(
        runner,
        and(
          eq(runner.userId, runs.userId),
          eq(runner.organizationId, runs.organizationId),
          eq(runner.desktopId, runs.desktopId),
        ),
      )
      .where(
        and(
          eq(runs.runId, runId),
          eq(runs.userId, owner.userId),
          eq(runs.organizationId, owner.organizationId),
        ),
      )
      .limit(1);
    if (run === undefined) {
      return { type: "run_not_found" };
    }
    if (!DESKTOP_RUNNER_OPEN_RUN_STATES.some((state) => state === run.state)) {
      return { type: "run_ended", state: run.state };
    }
    if (options.answersRequestId !== null) {
      const [request] = await tx
        .select({ seq: desktopRunnerEvents.seq })
        .from(desktopRunnerEvents)
        .where(
          and(
            eq(desktopRunnerEvents.runId, runId),
            eq(desktopRunnerEvents.requestId, options.answersRequestId),
          ),
        )
        .limit(1);
      if (request === undefined) {
        return { type: "approval_not_requested" };
      }
    }
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    const inserted = await tx
      .insert(desktopRunnerCommands)
      .values({
        runId,
        kind: options.kind,
        commandKey: options.commandKey,
        payload: options.payload,
      })
      .onConflictDoNothing()
      .returning({ id: desktopRunnerCommands.id });
    if (inserted.length === 0) {
      return { type: "duplicate" };
    }
    return {
      type: "queued",
      holder:
        run.connection === "connected"
          ? { sessionId: run.sessionId, instanceId: run.instanceId }
          : null,
    };
  });

type ReadRunOptions = { owner: RunOwner; runId: string };

export type DesktopRunnerRunView = {
  readonly runId: string;
  readonly desktopId: string;
  readonly harness: AgentHarness;
  readonly harnessVersion: string;
  readonly state: DesktopRunnerRunState;
  readonly outcome: (typeof runs.$inferSelect)["outcome"];
  readonly rejectReason: (typeof runs.$inferSelect)["rejectReason"];
  readonly harnessSessionId: string | null;
  readonly ackSeq: number;
  readonly leaseExpiresAt: Date;
};

/** One run of `owner`, or `null` when it has none by that id. */
export const readRun = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, runId }: ReadRunOptions,
): Promise<DesktopRunnerRunView | null> =>
  (
    await db
      .select({
        runId: runs.runId,
        desktopId: runs.desktopId,
        harness: runs.harness,
        harnessVersion: runs.harnessVersion,
        state: runs.state,
        outcome: runs.outcome,
        rejectReason: runs.rejectReason,
        harnessSessionId: runs.harnessSessionId,
        ackSeq: runs.ackSeq,
        leaseExpiresAt: runs.leaseExpiresAt,
      })
      .from(runs)
      .where(
        and(
          eq(runs.runId, runId),
          eq(runs.userId, owner.userId),
          eq(runs.organizationId, owner.organizationId),
        ),
      )
      .limit(1)
  ).at(0) ?? null;

type ReadEventsOptions = ReadRunOptions & { afterSeq: number; limit: number };

export type StoredRunEvent = {
  readonly seq: number;
  readonly message: unknown;
};

/** A run's stored messages after `afterSeq`, in sequence order. */
export const readStoredRunEvents = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, runId, afterSeq, limit }: ReadEventsOptions,
): Promise<StoredRunEvent[]> =>
  await db
    .select({
      seq: desktopRunnerEvents.seq,
      message: desktopRunnerEvents.message,
    })
    .from(desktopRunnerEvents)
    .innerJoin(runs, eq(runs.runId, desktopRunnerEvents.runId))
    .where(
      and(
        eq(desktopRunnerEvents.runId, runId),
        eq(runs.userId, owner.userId),
        eq(runs.organizationId, owner.organizationId),
        gt(desktopRunnerEvents.seq, afterSeq),
      ),
    )
    .orderBy(asc(desktopRunnerEvents.seq))
    .limit(limit);
