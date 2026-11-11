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
  lt,
  max,
  ne,
  notExists,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import * as v from "valibot";

import type { AgentHarness } from "@stll/api-contract/agent-harness";
import {
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  type DesktopRunnerApprovalMode,
  type DesktopRunnerDesktopMessage,
  type DesktopRunnerHarnessReport,
  desktopRunnerHarnessReportSchema,
  type DesktopRunnerLimits,
} from "@stll/api-contract/desktop-runner";

import type { RootDatabase, Transaction } from "@/api/db/root";
import {
  chatMessageRevisions,
  chatMessages,
  chatThreads,
  chatTurns,
  desktopRunnerCommands,
  desktopRunnerEvents,
  desktopRunnerRuns,
  desktopRunners,
  userFiles,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { CHAT_TURN_RUN_ENDING_STATUSES } from "@/api/lib/chat/turn-status";
import {
  withAggregateLock,
  withAggregateTransaction,
  withSkipLockedBatch,
} from "@/api/lib/db/aggregate-lock";
import { readBounded } from "@/api/lib/db/read-bounded";
import {
  transitionLifecycle,
  transitionLifecycleBatch,
} from "@/api/lib/db/transitions";
import { questionPauseOf } from "@/api/lib/desktop-runner/chunk";
import {
  carryFolderRestoreNotes,
  expireFolderRestoresOfKeys,
  hasPendingFolderRestore,
  hasUnnotedFolderRestore,
  markFolderRestoreNotesTold,
} from "@/api/lib/desktop-runner/folder-restores";
import { DESKTOP_RUNNER_RUN_TRANSITIONS } from "@/api/lib/desktop-runner/run-transitions";
import {
  DESKTOP_RUNNER_LEASED_RUN_STATES,
  DESKTOP_RUNNER_OPEN_RUN_STATES,
  type DesktopRunnerCommandKind,
  type DesktopRunnerEventType,
  type DesktopRunnerLostReason,
  type DesktopRunnerRunState,
} from "@/api/lib/desktop-runner/states";
import {
  brandPersistedChatThreadId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

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
  /** The credential that opened the socket; every heartbeat re-checks it. */
  readonly keyId: string;
};

const runner = desktopRunners;
const runs = desktopRunnerRuns;

/** A runner row is one installation under one device key. */
const runnerKey = ({
  userId,
  organizationId,
  desktopId,
  deviceJkt,
}: RunnerBinding) =>
  and(
    eq(runner.userId, userId),
    eq(runner.organizationId, organizationId),
    eq(runner.desktopId, desktopId),
    eq(runner.deviceJkt, deviceJkt),
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
  limits: Pick<DesktopRunnerLimits, "maxRunnersPerAccount">;
};

type HeldRun = {
  readonly runId: string;
  readonly state: DesktopRunnerRunState;
  readonly ackSeq: number;
  readonly workspaceIds: readonly SafeId<"workspace">[];
};

type ClaimSessionResult =
  | {
      type: "claimed";
      /** The socket this one replaces, to be told it is no longer current. */
      previous: { sessionId: string; instanceId: string } | null;
      /** The runs the desktop listed that are bound to it, after reconciling. */
      held: HeldRun[];
    }
  /** The account holds its maximum of installations and none could go. */
  | { type: "too_many_runners" }
  /** A newer key of the account replaced this one on the installation. */
  | { type: "retired" };

type AccountScope = Pick<RunnerBinding, "userId" | "organizationId">;

/** The account's installations; a retired key holds no place. */
const countRunners = async (tx: Transaction, scope: AccountScope) =>
  (
    await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(runner)
      .where(
        and(
          eq(runner.userId, scope.userId),
          eq(runner.organizationId, scope.organizationId),
          ne(runner.connection, "retired"),
        ),
      )
  ).at(0)?.count ?? 0;

/**
 * Remove up to `count` of the account's disconnected installations that hold
 * no open run, least recently seen first; their ended runs go with them.
 */
const evictIdleRunners = async (
  tx: Transaction,
  scope: AccountScope,
  count: number,
) => {
  // audit: skip - runner socket bookkeeping; the run's caller audits the work
  await tx.execute(sql`
    DELETE FROM ${runner}
    WHERE (${runner.userId}, ${runner.organizationId}, ${runner.desktopId}, ${runner.deviceJkt}) IN (
      SELECT idle.user_id, idle.organization_id, idle.desktop_id, idle.device_jkt
      FROM ${runner} AS idle
      WHERE idle.user_id = ${scope.userId}
        AND idle.organization_id = ${scope.organizationId}
        AND idle.connection = 'disconnected'
        AND NOT EXISTS (
          SELECT 1 FROM ${runs} AS held
          WHERE held.user_id = idle.user_id
            AND held.organization_id = idle.organization_id
            AND held.desktop_id = idle.desktop_id
            AND held.device_jkt = idle.device_jkt
            AND held.state IN (${sql.join(
              DESKTOP_RUNNER_OPEN_RUN_STATES.map((state) => sql`${state}`),
              sql`, `,
            )})
        )
      ORDER BY idle.last_seen_at ASC
      LIMIT ${count}
    )`);
};

/**
 * The account's other device keys naming this installation, retired once a
 * socket claims it under a new key (a relink). A retired key is never routed
 * to again, its socket is superseded at its next heartbeat, and it can never
 * claim the installation back. Its open runs end at once: the installation
 * id is the desktop's own claim, so no run moves to the claiming key, whose
 * socket would then receive another computer's work. A run no computer
 * accepted ends as not reached; an accepted one as ended by the relink,
 * since the new key can never continue it. Its folder restores expire, so
 * none blocks the thread. Another account naming the installation is never
 * touched.
 */
const retireEarlierDeviceKeys = async (
  tx: Transaction,
  binding: RunnerBinding,
  now: Date,
) => {
  // audit: skip - runner socket bookkeeping; the run's caller audits the work
  const retired = await tx
    .update(runner)
    .set({ connection: "retired" })
    .where(
      and(
        eq(runner.userId, binding.userId),
        eq(runner.organizationId, binding.organizationId),
        eq(runner.desktopId, binding.desktopId),
        ne(runner.deviceJkt, binding.deviceJkt),
        ne(runner.connection, "retired"),
      ),
    )
    .returning({ deviceJkt: runner.deviceJkt });
  if (retired.length === 0) {
    return;
  }
  const deviceJkts = retired.map(({ deviceJkt }) => deviceJkt);
  const ofRetired = and(
    eq(runs.userId, binding.userId),
    eq(runs.organizationId, binding.organizationId),
    eq(runs.desktopId, binding.desktopId),
    inArray(runs.deviceJkt, deviceJkts),
  );
  // An account holds few installations and keys, each with few open runs.
  const open = await tx
    .select({ runId: runs.runId, acceptedAt: runs.acceptedAt })
    .from(runs)
    .where(and(ofRetired, inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES)));
  for (const [lostReason, ids] of [
    ["not_reached", open.filter(({ acceptedAt }) => acceptedAt === null)],
    ["computer_relinked", open.filter(({ acceptedAt }) => acceptedAt !== null)],
  ] as const) {
    await transitionLifecycleBatch({
      tx,
      spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
      ids: ids.map(({ runId }) => runId),
      moves: { state: { from: DESKTOP_RUNNER_OPEN_RUN_STATES, to: "lost" } },
      guard: guarded(ofRetired),
      set: { lostReason, updatedAt: now },
      recordTransitionAuditEvent: skipRunAudit,
    });
  }
  await expireFolderRestoresOfKeys(tx, {
    owner: binding,
    desktopId: binding.desktopId,
    deviceJkts,
    now,
  });
};

/**
 * Make this socket the desktop's current one and reconcile its runs with what
 * the desktop says it holds: a held open run is running again, an unaccepted
 * one it does not hold is offered again, and an accepted one it does not hold
 * is lost.
 */
export const claimRunnerSession = async (
  db: DesktopRunnerDb,
  {
    binding,
    sessionId,
    instanceId,
    hello,
    now,
    leaseMs,
    limits,
  }: ClaimSessionOptions,
): Promise<ClaimSessionResult> =>
  await withAggregateTransaction(db, async (tx) => {
    // Claims of one account are serialized before the current session is
    // read, so overlapping claims for one runner each see the earlier claim's
    // committed session as `previous`. Admissions stay serialized from the
    // count through the insert, so concurrent new installations never pass
    // the cap together.
    await withAggregateLock({
      aggregate: "desktopRunnerCapacity",
      id: { organizationId: binding.organizationId, userId: binding.userId },
      tx,
    });
    const [existing] = await tx
      .select({
        sessionId: runner.sessionId,
        instanceId: runner.instanceId,
        connection: runner.connection,
      })
      .from(runner)
      .where(runnerKey(binding))
      .limit(1);
    if (existing?.connection === "retired") {
      return { type: "retired" };
    }
    // Before the cap is read: the keys a relink replaces hold no place.
    await retireEarlierDeviceKeys(tx, binding, now);
    if (existing === undefined) {
      const registered = await countRunners(tx, binding);
      if (registered >= limits.maxRunnersPerAccount) {
        await evictIdleRunners(
          tx,
          binding,
          registered - limits.maxRunnersPerAccount + 1,
        );
        if ((await countRunners(tx, binding)) >= limits.maxRunnersPerAccount) {
          return { type: "too_many_runners" };
        }
      }
    }
    const values = {
      keyId: binding.keyId,
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
        deviceJkt: binding.deviceJkt,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          runner.userId,
          runner.organizationId,
          runner.desktopId,
          runner.deviceJkt,
        ],
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
    // `hello` lists at most MAX_HELD_RUNS runs, so the read is bounded by them.
    const heldRead = await readBounded(
      tx
        .select({
          runId: runs.runId,
          state: runs.state,
          ackSeq: runs.ackSeq,
          workspaceIds: runs.workspaceIds,
        })
        .from(runs)
        .where(
          and(
            boundTo(binding),
            inArray(runs.runId, [...heldIds]),
            // An ended run is left out of `welcome`, so the desktop drops it.
            inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
          ),
        )
        .orderBy(asc(runs.runId)),
      MAX_HELD_RUNS,
    );
    const held =
      heldRead.type === "complete"
        ? heldRead.rows
        : panic("A hello lists more runs than the contract allows");
    return {
      type: "claimed",
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

/** The update shape both the owner transaction and the auth cleanup steps offer. */
type RunnerReleaseTransaction = {
  update: (table: typeof desktopRunners) => {
    set: (values: { connection: "disconnected" }) => {
      where: (condition: SQL | undefined) => PromiseLike<unknown>;
    };
  };
};

type RevokedRunnerScope =
  /** Access ended for the account, in one organization or in every one. */
  | {
      readonly userId: SafeId<"user">;
      readonly organizationId?: SafeId<"organization">;
      readonly keyId?: never;
    }
  /** One credential was revoked: only the runners it opened. */
  | {
      readonly userId: SafeId<"user">;
      readonly organizationId: SafeId<"organization">;
      readonly keyId: string;
    };

/**
 * A credential was revoked: its runners stop taking runs at once, and each
 * open socket closes at its next heartbeat, which re-checks the credential.
 * Runs stay bound to the runner and end through their leases and expiry.
 * Runners another credential opened stay connected, even on the same device
 * key.
 */
export const releaseRevokedRunners = async (
  tx: RunnerReleaseTransaction,
  { userId, organizationId, keyId }: RevokedRunnerScope,
) => {
  // audit: skip - the revocation that calls this records its own audit event
  await tx
    .update(desktopRunners)
    .set({ connection: "disconnected" })
    .where(
      and(
        eq(runner.userId, userId),
        organizationId === undefined
          ? undefined
          : eq(runner.organizationId, organizationId),
        keyId === undefined ? undefined : eq(runner.keyId, keyId),
        // A retired key stays retired.
        ne(runner.connection, "retired"),
      ),
    );
};

/** Record that a socket closed, unless a newer one already took over. */
export const releaseRunnerSession = async (
  db: DesktopRunnerDb,
  { binding, sessionId }: SessionOptions,
) => {
  // audit: skip - runner socket bookkeeping; the run's caller audits the work
  await db
    .update(runner)
    .set({ connection: "disconnected" })
    .where(
      and(
        runnerKey(binding),
        eq(runner.sessionId, sessionId),
        // A retired key stays retired when its socket closes.
        eq(runner.connection, "connected"),
      ),
    );
};

type RenewOptions = SessionOptions & { now: Date; leaseMs: number };

type RenewResult =
  /** Another socket of the same installation and key is current. */
  | { type: "superseded" }
  /**
   * The runs this socket holds that are still open, and those of them that are
   * running, read with the renewal. A run started but not yet accepted is open
   * and not running.
   */
  | {
      type: "current";
      open: ReadonlySet<string>;
      running: ReadonlySet<string>;
    };

/**
 * A heartbeat of the current socket: the runner is seen, and every open run it
 * holds keeps its lease. A run whose lease lapsed while the socket stayed open
 * returns to the state it had. Returns `false` when this socket is no longer
 * the desktop's current one.
 */
export const renewRunnerSession = async (
  db: DesktopRunnerDb,
  { binding, sessionId, now, leaseMs }: RenewOptions,
): Promise<RenewResult> =>
  await withAggregateTransaction(db, async (tx) => {
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    // A runner retired by a newer device key of its installation is no
    // longer current, whichever socket holds it.
    const seen = await tx
      .update(runner)
      .set({ lastSeenAt: now })
      .where(
        and(
          runnerKey(binding),
          eq(runner.sessionId, sessionId),
          eq(runner.connection, "connected"),
        ),
      )
      .returning({ sessionId: runner.sessionId });
    if (seen.length === 0) {
      return { type: "superseded" };
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
    const open = await tx
      .select({ runId: runs.runId, state: runs.state })
      .from(runs)
      .where(
        and(
          boundTo(binding),
          inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
        ),
      );
    return {
      type: "current",
      open: new Set(open.map(({ runId }) => runId)),
      running: new Set(
        open
          .filter(({ state }) => state === "running")
          .map(({ runId }) => runId),
      ),
    };
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
      // The run's request reached the harness: any restore note it carried
      // is told now, and no later run repeats it.
      await markFolderRestoreNotesTold(tx, { runId, now });
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
  | { type: "invalid_state"; state: DesktopRunnerRunState }
  /** The message would take the run past what it may store; the run is lost. */
  | { type: "run_limit" };

type RunStorageLimits = Pick<
  DesktopRunnerLimits,
  "maxMessagesPerRun" | "maxMessageBytesPerRun"
>;

/** Run states that accept the next sequenced message. */
const SEQUENCED_RUN_STATES = [
  "running",
  "waiting_for_computer",
] as const satisfies readonly DesktopRunnerRunState[];

type AdvanceOptions = {
  tx: Transaction;
  binding: RunnerBinding;
  message: SequencedRunMessage;
  /** UTF-8 bytes of the message as stored. */
  bytes: number;
  now: Date;
  leaseMs: number;
  limits: RunStorageLimits;
};

/**
 * Advance a run's acknowledged position by one. A message proves the desktop
 * accepted the run; `run.finished` ends it, anything else keeps it running.
 */
const advanceRun = async ({
  tx,
  binding,
  message,
  bytes,
  now,
  leaseMs,
  limits,
}: AdvanceOptions) => {
  const guard = guarded(
    boundTo(binding),
    eq(runs.ackSeq, message.seq - 1),
    sql`${runs.messageBytes} + ${bytes} <= ${limits.maxMessageBytesPerRun}`,
  );
  const advanced = {
    ackSeq: message.seq,
    messageBytes: sql`${runs.messageBytes} + ${bytes}`,
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

/**
 * The request a stored message asks the member to answer: an approval
 * request, or an event whose chunk pauses the run for a blocking question.
 * An answer is matched to the run by it.
 */
const requestIdOf = (message: SequencedRunMessage): string | null => {
  switch (message.type) {
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest:
      return message.requestId;
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent: {
      const pause = questionPauseOf(message.chunk);
      // The socket refuses a malformed pause before it is stored.
      return pause.type === "question" ? pause.requestId : null;
    }
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished:
      return null;
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
  limits: RunStorageLimits;
};

/**
 * Store the next message of a run and advance its acknowledged position in
 * one transaction. Positions advance one at a time, so the stored log never
 * has a hole; a position already stored is a duplicate and changes nothing.
 */
export const persistRunMessage = async (
  db: DesktopRunnerDb,
  { binding, message, now, leaseMs, limits }: PersistRunMessageOptions,
): Promise<PersistedRunMessage> =>
  await withAggregateTransaction(db, async (tx) => {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    const advanced =
      message.seq > limits.maxMessagesPerRun
        ? ({ type: "stale" } as const)
        : await advanceRun({
            tx,
            binding,
            message,
            bytes,
            now,
            leaseMs,
            limits,
          });
    if (advanced.type === "transitioned") {
      await tx.insert(desktopRunnerEvents).values({
        runId: message.runId,
        seq: message.seq,
        type: message.type,
        requestId: requestIdOf(message),
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
    if (!SEQUENCED_RUN_STATES.some((state) => state === run.state)) {
      return { type: "invalid_state", state: run.state };
    }
    // The next position of an open run failed only on what the run may store.
    const ended = await transitionLifecycle({
      tx,
      spec: DESKTOP_RUNNER_RUN_TRANSITIONS,
      id: message.runId,
      moves: { state: { from: SEQUENCED_RUN_STATES, to: "lost" } },
      guard: guarded(boundTo(binding)),
      set: { updatedAt: now },
      recordTransitionAuditEvent: skipRunAudit,
    });
    return ended.type === "transitioned"
      ? { type: "run_limit" }
      : { type: "invalid_state", state: run.state };
  });

/** Run states after which nothing more happens to a run. */
const ENDED_RUN_STATES = [
  "finished",
  "rejected",
  "lost",
] as const satisfies readonly DesktopRunnerRunState[];

type PruneEndedRunsOptions = { now: Date; retentionMs: number; limit: number };

/**
 * Delete runs that ended more than the retention window ago; their commands
 * and messages go with them by cascade.
 */
export const pruneEndedRuns = async (
  db: DesktopRunnerDb,
  { now, retentionMs, limit }: PruneEndedRunsOptions,
): Promise<string[]> => {
  const cutoff = new Date(now.getTime() - retentionMs);
  return await withSkipLockedBatch({
    database: db,
    limit,
    select: (tx) =>
      tx
        .select({ runId: runs.runId })
        .from(runs)
        .where(
          and(
            inArray(runs.state, ENDED_RUN_STATES),
            sql`${runs.updatedAt} <= ${cutoff}::timestamptz`,
          ),
        )
        .orderBy(asc(runs.updatedAt))
        .limit(limit)
        .$dynamic(),
    run: async (tx, rows) => {
      if (rows.length === 0) {
        return [];
      }
      // audit: skip - retention of runner bookkeeping past its window
      const deleted = await tx
        .delete(runs)
        .where(
          and(
            inArray(
              runs.runId,
              rows.map(({ runId }) => runId),
            ),
            inArray(runs.state, ENDED_RUN_STATES),
          ),
        )
        .returning({ runId: runs.runId });
      return deleted.map(({ runId }) => runId);
    },
  });
};

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

type ExpireAbandonedOptions = {
  now: Date;
  abandonedMs: number;
  unacceptedMs: number;
  limit: number;
};

/**
 * End runs never written to a socket within the unaccepted window, and the
 * others whose computer has not taken or come back to them within the
 * abandon window, as `lost`. A run is never handed to another computer, so
 * this is how the API ends one its desktop no longer serves. A run never
 * written is counted from its creation: a heartbeat renews its lease, and
 * however its delivery failed (a lost ring, a key the computer no longer
 * connects with), the turn learns in bounded time that its computer did not
 * pick it up. A run that was written keeps the longer window, since the
 * desktop starts a run before its acceptance reaches the API.
 */
export const expireAbandonedRuns = async (
  db: DesktopRunnerDb,
  { now, abandonedMs, unacceptedMs, limit }: ExpireAbandonedOptions,
): Promise<string[]> => {
  const abandonedBefore = new Date(now.getTime() - abandonedMs);
  const unacceptedBefore = new Date(now.getTime() - unacceptedMs);
  const ended = () =>
    or(
      // Never written to a socket: no computer can be running it.
      and(
        inArray(runs.state, ["assigned", "waiting_for_computer"]),
        isNull(runs.deliveredAt),
        sql`${runs.createdAt} <= ${unacceptedBefore}::timestamptz`,
      ),
      // Written to a socket but never accepted: its computer may be running
      // it and lost the connection before the acceptance arrived.
      and(
        eq(runs.state, "assigned"),
        sql`${runs.createdAt} <= ${abandonedBefore}::timestamptz`,
      ),
      and(
        eq(runs.state, "waiting_for_computer"),
        sql`${runs.updatedAt} <= ${abandonedBefore}::timestamptz`,
      ),
    );
  return await withSkipLockedBatch({
    database: db,
    limit,
    select: (tx) =>
      tx
        .select({ runId: runs.runId })
        .from(runs)
        .where(ended())
        .orderBy(asc(runs.updatedAt))
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
          state: { from: ["assigned", "waiting_for_computer"], to: "lost" },
        },
        guard: guarded(ended()),
        set: { updatedAt: now },
        recordTransitionAuditEvent: skipRunAudit,
      });
    },
  });
};

/**
 * Queue a cancel for every open chat run whose turn no longer holds it
 * (`CHAT_TURN_RUN_ENDING_STATUSES`): the turn was stopped, failed, superseded
 * or ended while its run still waited or worked, or the turn is gone (a
 * truncation deleted it, or the run predates turn references). A turn may end on any API
 * task, or with no task alive, so the sweep finds these from the rows rather
 * than from whoever ended the turn. One statement queues them all; a run
 * keeps one cancel (its key is the run), so a later sweep queues nothing more.
 * Returns where to ring for the cancels whose computer is connected.
 */
export const cancelRunsOfEndedChatTurns = async (
  db: Pick<DesktopRunnerDb, "select" | "insert">,
  { limit }: { limit: number },
): Promise<RunHolder[]> => {
  const ended = db
    .select({
      runId: runs.runId,
      kind: sql<"run.cancel">`'run.cancel'`.as("kind"),
      commandKey: sql<string>`${runs.runId}`.as("command_key"),
      payload:
        sql<object>`jsonb_build_object('type', 'run.cancel', 'runId', ${runs.runId}::text)`.as(
          "payload",
        ),
    })
    .from(runs)
    .leftJoin(chatTurns, eq(chatTurns.id, runs.chatTurnId))
    .where(
      and(
        inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
        isNotNull(runs.chatThreadId),
        or(
          isNull(runs.chatTurnId),
          inArray(chatTurns.status, CHAT_TURN_RUN_ENDING_STATUSES),
        ),
        // A run with its cancel queued is not read again.
        sql`NOT EXISTS (SELECT 1 FROM ${desktopRunnerCommands} WHERE ${desktopRunnerCommands.runId} = ${runs.runId} AND ${desktopRunnerCommands.kind} = 'run.cancel')`,
      ),
    )
    .orderBy(asc(runs.updatedAt))
    .limit(limit);
  // audit: skip - runner socket bookkeeping; the chat turn that ended audits the work
  const queued = await db
    .insert(desktopRunnerCommands)
    .select(ended)
    .onConflictDoNothing()
    .returning({ runId: desktopRunnerCommands.runId });
  if (queued.length === 0) {
    return [];
  }
  return await db
    .select({ sessionId: runner.sessionId, instanceId: runner.instanceId })
    .from(runs)
    .innerJoin(
      runner,
      and(
        eq(runner.userId, runs.userId),
        eq(runner.organizationId, runs.organizationId),
        eq(runner.desktopId, runs.desktopId),
        eq(runner.deviceJkt, runs.deviceJkt),
        eq(runner.connection, "connected"),
      ),
    )
    .where(
      inArray(
        runs.runId,
        queued.map(({ runId }) => runId),
      ),
    );
};

export type PendingCommand = {
  readonly id: number;
  readonly runId: string;
  readonly kind: DesktopRunnerCommandKind;
  readonly payload: unknown;
  readonly workspaceIds: readonly SafeId<"workspace">[];
};

/**
 * Record that these runs' `run.start` is being written to this socket, before
 * it is: from then on their computer may be running them, so they keep the
 * recovery window rather than the unaccepted one. The first write is kept.
 */
const recordRunsDelivered = async (
  db: DesktopRunnerDb,
  {
    binding,
    runIds,
    now,
  }: { binding: RunnerBinding; runIds: readonly string[]; now: Date },
) => {
  if (runIds.length === 0) {
    return;
  }
  // audit: skip - runner socket bookkeeping; the run's caller audits the work
  await db
    .update(runs)
    .set({
      deliveredAt: sql`coalesce(${runs.deliveredAt}, ${now}::timestamptz)`,
    })
    .where(and(inArray(runs.runId, [...runIds]), boundTo(binding)));
};

type PendingCommandsOptions = SessionOptions & {
  afterId: number;
  limit: number;
  now: Date;
};

type PendingCommandsResult =
  { type: "current"; commands: PendingCommand[] } | { type: "superseded" };

/**
 * Commands queued after `afterId` for the open runs bound to this socket, in
 * queue order, taken to be written to it: each run whose `run.start` is among
 * them records that it was delivered before any frame goes out, since its
 * computer may be running it from then on. A socket that is no longer the
 * desktop's current one gets none: the commands are read in the same
 * statement that matches this socket's session on the runner row, so a
 * takeover committed at any point leaves the superseded socket without them.
 */
export const takePendingCommands = async (
  db: DesktopRunnerDb,
  { binding, sessionId, afterId, limit, now }: PendingCommandsOptions,
): Promise<PendingCommandsResult> => {
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
    .innerJoin(runner, and(runnerKey(binding), eq(runner.sessionId, sessionId)))
    .where(
      and(
        boundTo(binding),
        inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
        gt(desktopRunnerCommands.id, afterId),
      ),
    )
    .orderBy(asc(desktopRunnerCommands.id))
    .limit(limit);
  if (rows.length === 0) {
    // No command in a snapshot where this socket was current, or none at all
    // because it was not: the runner row says which.
    const [current] = await db
      .select({ sessionId: runner.sessionId })
      .from(runner)
      .where(and(runnerKey(binding), eq(runner.sessionId, sessionId)))
      .limit(1);
    if (current === undefined) {
      return { type: "superseded" };
    }
  }
  await recordRunsDelivered(db, {
    binding,
    runIds: rows
      .filter(({ kind }) => kind === "run.start")
      .map(({ runId }) => runId),
    now,
  });
  return {
    type: "current",
    commands: rows.map((row) => ({
      ...row,
      workspaceIds: row.workspaceIds.map(brandPersistedWorkspaceId),
    })),
  };
};

type QueuedCommandsOptions = {
  instanceId: string;
  /** Resume after this socket, so successive sweeps page across every one. */
  afterSessionId: string | null;
  limit: number;
};

type QueuedCommands = {
  readonly sessionId: string;
  /** The newest command queued for the socket's open runs. */
  readonly newestCommandId: number;
};

/**
 * The connected sockets this API task holds whose open runs have commands,
 * each with its newest command, in socket order after `afterSessionId`. A
 * socket that has not sent through that command is one a lost doorbell ring
 * left waiting, however long ago the command was queued.
 */
export const readNewestQueuedCommands = async (
  db: Pick<DesktopRunnerDb, "select">,
  { instanceId, afterSessionId, limit }: QueuedCommandsOptions,
): Promise<QueuedCommands[]> =>
  (
    await db
      .select({
        sessionId: runner.sessionId,
        newestCommandId: max(desktopRunnerCommands.id),
      })
      .from(runner)
      .innerJoin(
        runs,
        and(
          eq(runs.userId, runner.userId),
          eq(runs.organizationId, runner.organizationId),
          eq(runs.desktopId, runner.desktopId),
          eq(runs.deviceJkt, runner.deviceJkt),
        ),
      )
      .innerJoin(
        desktopRunnerCommands,
        eq(desktopRunnerCommands.runId, runs.runId),
      )
      .where(
        and(
          eq(runner.instanceId, instanceId),
          eq(runner.connection, "connected"),
          inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
          afterSessionId === null
            ? undefined
            : gt(runner.sessionId, afterSessionId),
        ),
      )
      .groupBy(runner.sessionId)
      .orderBy(asc(runner.sessionId))
      .limit(limit)
  ).map(({ sessionId, newestCommandId }) => ({
    sessionId,
    // The inner join gives every group at least one command.
    newestCommandId:
      newestCommandId ?? panic("A queued socket group has no command"),
  }));

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

/**
 * The chat turn a run is started for. The turn reads the run; the run lives
 * as long as the turn holds it (`CHAT_TURN_RUN_ENDING_STATUSES`).
 */
export type ChatRunBinding = {
  readonly threadId: SafeId<"chatThread">;
  readonly turnId: SafeId<"chatTurn">;
};

type InsertRunOptions = {
  owner: RunOwner;
  runId: string;
  desktopId: string;
  harness: AgentHarness;
  harnessVersion: string;
  model: string;
  approvals: DesktopRunnerApprovalMode;
  workspaceIds: readonly SafeId<"workspace">[];
  /** The chat turn that starts and reads the run, when one does. */
  chat?: ChatRunBinding | null;
  /**
   * The `run.start` as stored: `withNote` when a restore of the chat's folder
   * was not told to an accepted run yet, chosen inside the admission.
   */
  payload: { plain: object; withNote: object };
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
  | { type: "no_computer" }
  | {
      type: "harness_unavailable";
      report: DesktopRunnerHarnessReport | null;
    }
  | { type: "model_unavailable" }
  | { type: "approvals_unavailable" }
  /** The chat's folder is being restored on its computer. */
  | { type: "folder_busy" };

/**
 * Bind a new run to a connected runner and queue its `run.start`, both or
 * neither. The runner must report the harness ready at the requested version
 * with the requested model and approval mode. The caller mints the run id, so nothing here
 * answers for a run id another tenant holds.
 */
export const insertAssignedRun = async (
  db: DesktopRunnerDb,
  options: InsertRunOptions,
): Promise<InsertedRun> =>
  await withAggregateTransaction(db, async (tx) => {
    const { owner, runId, desktopId, harness, harnessVersion, now } = options;
    // Serialized with the account's restore requests and settlements, so a
    // restore is either pending here (refused below) or settled and noted.
    await withAggregateLock({
      aggregate: "desktopRunnerCapacity",
      id: { organizationId: owner.organizationId, userId: owner.userId },
      tx,
    });
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
      // Another device key may name the same installation; the newest wins.
      .orderBy(desc(runner.lastSeenAt))
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
    if (!report.approvalModes.includes(options.approvals)) {
      return { type: "approvals_unavailable" };
    }
    // A restore of the chat's folder that its computer may still act on: the
    // run would work in files about to change. The computer refuses such a
    // run too, for a restore asked while this one is stored.
    const chat = options.chat ?? null;
    if (
      chat !== null &&
      (await hasPendingFolderRestore(tx, {
        owner,
        threadId: chat.threadId,
        desktopId,
        deviceJkt: target.deviceJkt,
        now,
      }))
    ) {
      return { type: "folder_busy" };
    }
    const noted =
      chat !== null &&
      (await hasUnnotedFolderRestore(tx, { owner, threadId: chat.threadId }));
    // audit: skip - runner socket bookkeeping; the run's caller audits the work
    await tx.insert(runs).values({
      runId,
      userId: owner.userId,
      organizationId: owner.organizationId,
      desktopId,
      deviceJkt: target.deviceJkt,
      harness,
      harnessVersion,
      workspaceIds: [...options.workspaceIds],
      chatThreadId: options.chat?.threadId ?? null,
      chatTurnId: options.chat?.turnId ?? null,
      state: "assigned",
      leaseExpiresAt: leaseUntil(now, options.leaseMs),
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(desktopRunnerCommands).values({
      runId,
      kind: "run.start",
      commandKey: runId,
      payload: noted ? options.payload.withNote : options.payload.plain,
    });
    if (noted) {
      await carryFolderRestoreNotes(tx, {
        owner,
        threadId: chat.threadId,
        runId,
      });
    }
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
  /**
   * The request an answer names, and the stored message that asked it: an
   * approval answers a `run.approval_request`, question answers the
   * `run.event` that paused for the question.
   */
  answers: AnsweredRequest | null;
  limits: Pick<DesktopRunnerLimits, "maxCommandsPerRun">;
};

export type AnsweredRequest = {
  requestId: string;
  askedBy: Exclude<DesktopRunnerEventType, "run.finished">;
};

export type InsertedCommand =
  | { type: "queued"; holder: RunHolder | null }
  | { type: "duplicate" }
  | { type: "run_not_found" }
  | { type: "run_ended"; state: DesktopRunnerRunState }
  /** The run asked no request of that kind under that id. */
  | { type: "not_requested" }
  /** The run holds as many commands as one run may. */
  | { type: "command_limit" };

/**
 * Queue one command for an open run of `owner`. The command key makes a
 * repeat a duplicate, also once the run holds its cap; the holder is returned
 * only while its socket is open.
 */
export const insertRunCommand = async (
  db: DesktopRunnerDb,
  options: InsertCommandOptions,
): Promise<InsertedCommand> =>
  await withAggregateTransaction(db, async (tx) => {
    const { owner, runId } = options;
    // Commands for the account's runs are serialized from the cap count
    // through the insert, so concurrent commands never pass a run's cap
    // together.
    await withAggregateLock({
      aggregate: "desktopRunnerCapacity",
      id: { organizationId: owner.organizationId, userId: owner.userId },
      tx,
    });
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
          eq(runner.deviceJkt, runs.deviceJkt),
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
    const [repeat] = await tx
      .select({ id: desktopRunnerCommands.id })
      .from(desktopRunnerCommands)
      .where(
        and(
          eq(desktopRunnerCommands.runId, runId),
          eq(desktopRunnerCommands.kind, options.kind),
          eq(desktopRunnerCommands.commandKey, options.commandKey),
        ),
      )
      .limit(1);
    if (repeat !== undefined) {
      return { type: "duplicate" };
    }
    const [queued] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(desktopRunnerCommands)
      .where(eq(desktopRunnerCommands.runId, runId));
    // A stop always reaches the computer: a run at its cap must still end.
    // Its key is the run, so the duplicate check above keeps it to one each.
    const stops =
      options.kind === "run.interrupt" || options.kind === "run.cancel";
    if (!stops && (queued?.count ?? 0) >= options.limits.maxCommandsPerRun) {
      return { type: "command_limit" };
    }
    if (options.answers !== null) {
      const [request] = await tx
        .select({ seq: desktopRunnerEvents.seq })
        .from(desktopRunnerEvents)
        .where(
          and(
            eq(desktopRunnerEvents.runId, runId),
            eq(desktopRunnerEvents.requestId, options.answers.requestId),
            eq(desktopRunnerEvents.type, options.answers.askedBy),
          ),
        )
        .limit(1);
      if (request === undefined) {
        return { type: "not_requested" };
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
  readonly createdAt: Date;
  /** When `run.start` was first written to a socket; `null` while never. */
  readonly deliveredAt: Date | null;
  /** Why the API ended it as `lost`, where it knows. */
  readonly lostReason: DesktopRunnerLostReason | null;
  /** When the computer accepted the run; `null` while none picked it up. */
  readonly acceptedAt: Date | null;
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
        createdAt: runs.createdAt,
        deliveredAt: runs.deliveredAt,
        lostReason: runs.lostReason,
        acceptedAt: runs.acceptedAt,
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

/**
 * The chat thread of the owner's run that is still going; `null` for a run of
 * someone else, one that ended, or one no chat started. What a run's token may
 * write is read from here, never from the request.
 */
export const readOpenRunChatThread = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, runId }: ReadRunOptions,
): Promise<SafeId<"chatThread"> | null> => {
  const chatThreadId = (
    await db
      .select({ chatThreadId: runs.chatThreadId })
      .from(runs)
      .where(
        and(
          eq(runs.runId, runId),
          eq(runs.userId, owner.userId),
          eq(runs.organizationId, owner.organizationId),
          inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
        ),
      )
      .limit(1)
  ).at(0)?.chatThreadId;
  return chatThreadId === null || chatThreadId === undefined
    ? null
    : brandPersistedChatThreadId(chatThreadId);
};

type ReadRunOutputFileOptions = {
  owner: RunOwner;
  chatThreadId: SafeId<"chatThread">;
  fileId: SafeId<"userFile">;
};

/**
 * A stored file as a run's chat may show it; `null` unless it is the owner's
 * and in this thread of the owner's organization. A computer's report names a
 * file; this decides whether the chat gets one.
 */
export const readRunOutputFile = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, chatThreadId, fileId }: ReadRunOutputFileOptions,
) =>
  (
    await db
      .select({
        id: userFiles.id,
        fileName: userFiles.fileName,
        mimeType: userFiles.mimeType,
        placeholder: userFiles.placeholder,
      })
      .from(userFiles)
      .innerJoin(chatThreads, eq(chatThreads.id, userFiles.threadId))
      .where(
        and(
          eq(userFiles.id, fileId),
          eq(userFiles.userId, owner.userId),
          eq(userFiles.threadId, chatThreadId),
          eq(chatThreads.userId, owner.userId),
          eq(chatThreads.organizationId, owner.organizationId),
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

type MemberRunnersOptions = { owner: RunOwner; limit: number };

export type MemberRunner = {
  readonly desktopId: string;
  readonly connected: boolean;
  readonly lastSeenAt: Date;
  readonly harnesses: readonly DesktopRunnerHarnessReport[];
};

/**
 * The runners of `owner`, connected or not, most recently seen first: one
 * per installation, its newest device key. An account holds at most
 * `maxRunnersPerAccount` rows, which `limit` is expected to cover.
 */
export const readMemberRunners = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, limit }: MemberRunnersOptions,
): Promise<MemberRunner[]> => {
  const rows = await db
    .select({
      desktopId: runner.desktopId,
      connection: runner.connection,
      lastSeenAt: runner.lastSeenAt,
      harnesses: runner.harnesses,
    })
    .from(runner)
    .where(
      and(
        eq(runner.userId, owner.userId),
        eq(runner.organizationId, owner.organizationId),
        ne(runner.connection, "retired"),
      ),
    )
    .orderBy(desc(runner.lastSeenAt), asc(runner.desktopId))
    .limit(limit);
  // Another device key may name the same installation. Routing takes its
  // newest connected key, so that one stands for the installation; without
  // one, the newest key does.
  const byInstallation = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const kept = byInstallation.get(row.desktopId);
    if (
      kept === undefined ||
      (kept.connection !== "connected" && row.connection === "connected")
    ) {
      byInstallation.set(row.desktopId, row);
    }
  }
  return [...byInstallation.values()].map((row) => ({
    desktopId: row.desktopId,
    connected: row.connection === "connected",
    lastSeenAt: row.lastSeenAt,
    harnesses: storedHarnessReports(row.harnesses),
  }));
};

type ChatRunSessionOptions = {
  owner: RunOwner;
  /** The thread and the turn about to start on the computer. */
  chat: ChatRunBinding;
  desktopId: string;
  harness: AgentHarness;
};

/**
 * The harness session turn `chat.turnId` resumes on this computer and
 * harness, or `null` when the turn starts a fresh one and hands the harness
 * the chat's own history.
 *
 * A session holds every turn the runs that continued it were given and
 * answered, so it is resumed only while the chat still holds exactly those:
 * the newest run of the thread on this computer and harness left it, and its
 * turn's answer is still the message right before the one this turn answers.
 * An edit or a regeneration deletes that answer and every later message, and
 * an answer from the cloud or from another computer or harness takes its
 * place, so any of them starts fresh; a revision of any message of the thread
 * since that run's turn began does too, because the session holds the text
 * it replaced (no revision is accepted while a turn runs). A fork is another
 * thread and holds no run, so it starts fresh.
 */
export const readChatRunSession = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, chat, desktopId, harness }: ChatRunSessionOptions,
): Promise<string | null> => {
  // The run that last wrote the session: a later one resumed it or replaced
  // it, whatever state it ended in.
  const newest = db
    .select({
      state: runs.state,
      harnessSessionId: runs.harnessSessionId,
      chatTurnId: runs.chatTurnId,
    })
    .from(runs)
    .where(
      and(
        eq(runs.chatThreadId, chat.threadId),
        eq(runs.desktopId, desktopId),
        eq(runs.harness, harness),
        eq(runs.userId, owner.userId),
        eq(runs.organizationId, owner.organizationId),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.runId))
    .limit(1)
    .as("newest_run");
  // The message right before the one this turn answers, in the thread's
  // order: the answer this turn continues. The boundary is the asking
  // message's own row, read in the database by id.
  const continued = db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, chat.threadId),
        sql`(${chatMessages.createdAt}, ${chatMessages.id}) < (select m.created_at, m.id from chat_messages m join chat_turns t on t.user_message_id = m.id and t.thread_id = m.thread_id where t.id = ${chat.turnId} and t.thread_id = ${chat.threadId})`,
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1);
  const rows = await db
    .select({ harnessSessionId: newest.harnessSessionId })
    .from(newest)
    .innerJoin(chatTurns, eq(chatTurns.id, newest.chatTurnId))
    .where(
      and(
        eq(newest.state, "finished"),
        isNotNull(newest.harnessSessionId),
        eq(chatTurns.threadId, chat.threadId),
        eq(chatTurns.assistantMessageId, sql`(${continued})`),
        // Both times are the database's own: the turn's start, read by id.
        notExists(
          db
            .select({ id: chatMessageRevisions.id })
            .from(chatMessageRevisions)
            .where(
              and(
                eq(chatMessageRevisions.threadId, chat.threadId),
                sql`${chatMessageRevisions.createdAt} >= (select t.created_at from chat_turns t where t.id = ${newest.chatTurnId})`,
              ),
            ),
        ),
      ),
    )
    .limit(1);
  return rows.at(0)?.harnessSessionId ?? null;
};

type ChatRunForRequestOptions = {
  owner: RunOwner;
  chat: ChatRunBinding;
  requestId: string;
};

export type ChatRunForRequest = {
  readonly runId: string;
  readonly harness: AgentHarness;
  readonly state: DesktopRunnerRunState;
  /** Where the chat turn stopped reading the run. */
  readonly chatReadSeq: number;
  /** The stored message that asked: an approval request or a question's pause. */
  readonly askedBy: DesktopRunnerEventType;
  /** That message as the desktop sent it. */
  readonly request: unknown;
};

/**
 * The run of the chat turn that asked request `requestId` (an approval or a
 * blocking question), or `null` when no run of this turn, thread and member
 * did.
 */
export const readChatRunForRequest = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, chat, requestId }: ChatRunForRequestOptions,
): Promise<ChatRunForRequest | null> =>
  (
    await db
      .select({
        runId: runs.runId,
        harness: runs.harness,
        state: runs.state,
        chatReadSeq: runs.chatReadSeq,
        askedBy: desktopRunnerEvents.type,
        request: desktopRunnerEvents.message,
      })
      .from(runs)
      .innerJoin(
        desktopRunnerEvents,
        and(
          eq(desktopRunnerEvents.runId, runs.runId),
          eq(desktopRunnerEvents.requestId, requestId),
        ),
      )
      .where(
        and(
          eq(runs.chatThreadId, chat.threadId),
          eq(runs.chatTurnId, chat.turnId),
          eq(runs.userId, owner.userId),
          eq(runs.organizationId, owner.organizationId),
        ),
      )
      .limit(1)
  ).at(0) ?? null;

type ChatReadSeqOptions = { owner: RunOwner; runId: string; seq: number };

/**
 * Record how far a chat turn read the run. The position only moves forward,
 * so a slower writer never rewinds a turn that read further.
 */
export const recordChatReadSeq = async (
  db: Pick<DesktopRunnerDb, "update">,
  { owner, runId, seq }: ChatReadSeqOptions,
): Promise<void> => {
  // audit: skip - read position bookkeeping; the chat turn audits the work
  await db
    .update(runs)
    .set({ chatReadSeq: seq })
    .where(
      and(
        eq(runs.runId, runId),
        eq(runs.userId, owner.userId),
        eq(runs.organizationId, owner.organizationId),
        lt(runs.chatReadSeq, seq),
      ),
    );
};
