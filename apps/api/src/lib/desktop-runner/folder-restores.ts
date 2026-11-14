import { panic } from "better-result";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";

import {
  CHAT_LOCAL_FILES_UNDONE_METADATA_KEY,
  type ChatLocalFilesUndoComputerRefusal,
  type ChatLocalFilesUndone,
  type ChatLocalFilesUndoRefusal,
  type ChatLocalFilesUndoState,
} from "@stll/api-contract/chat-local-files-undo";
import {
  DESKTOP_RUNNER_CHECKPOINT_EVENT,
  DESKTOP_RUNNER_FOLDER_RESTORE_PROTOCOL,
  type DesktopRunnerFolderRestoreOutcome,
} from "@stll/api-contract/desktop-runner";

import {
  chatMessages,
  chatTurns,
  desktopRunnerEvents,
  desktopRunnerFolderRestores,
  desktopRunnerRuns,
  desktopRunners,
} from "@/api/db/schema";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createBackgroundAuditRecorder,
} from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { NEWEST_CHAT_TURN_FIRST } from "@/api/lib/chat/turn-order";
import { CHAT_TURN_RUN_ENDING_STATUSES } from "@/api/lib/chat/turn-status";
import {
  withAggregateLock,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import {
  transitionLifecycle,
  transitionLifecycleBatch,
} from "@/api/lib/db/transitions";
import { DESKTOP_RUNNER_FOLDER_RESTORE_TRANSITIONS } from "@/api/lib/desktop-runner/run-transitions";
import { DESKTOP_RUNNER_OPEN_RUN_STATES } from "@/api/lib/desktop-runner/states";
import type {
  DesktopRunnerDb,
  RunHolder,
  RunnerBinding,
  RunOwner,
} from "@/api/lib/desktop-runner/store";
import { logger } from "@/api/lib/observability/logger";

/**
 * Folder restores: a member's request to put a chat's folder back as the
 * checkpoint a run took before its turn. A request is queued for the run's
 * computer, taken by its socket (`sent`) and settled by the computer's answer.
 * A queued request expires unsent after a short while, so a computer that is
 * away never restores later; every read treats a queued request past its time
 * as expired. A sent one waits for its answer, however late, and is sent again
 * on each new socket of the computer.
 */

const restores = desktopRunnerFolderRestores;
const runs = desktopRunnerRuns;
const runner = desktopRunners;
const events = desktopRunnerEvents;

// Socket bookkeeping: the endpoint that asks for a restore audits it.
const skipRestoreAudit = async () => await Promise.resolve();

/** A restore as a member sees it; a queued one past its time reads `expired`. */
export type FolderRestoreView = {
  readonly restoreId: string;
  readonly state: ChatLocalFilesUndoState;
  readonly reason: ChatLocalFilesUndoComputerRefusal | null;
};

type StoredRestore = {
  id: string;
  state: ChatLocalFilesUndoState;
  reason: ChatLocalFilesUndoComputerRefusal | null;
  expiresAt: Date;
};

const restoreColumns = {
  id: restores.id,
  state: restores.state,
  reason: restores.reason,
  expiresAt: restores.expiresAt,
};

const lapsed = (row: StoredRestore, now: Date) =>
  row.state === "queued" && row.expiresAt <= now;

const viewOf = (row: StoredRestore, now: Date): FolderRestoreView => ({
  restoreId: row.id,
  state: lapsed(row, now) ? "expired" : row.state,
  reason: row.reason,
});

/** Still waiting for a socket at `now`. */
const inTime = (now: Date) => sql`${restores.expiresAt} > ${now}::timestamptz`;
/** Past its time at `now`. */
const lapsedAt = (now: Date) =>
  sql`${restores.expiresAt} <= ${now}::timestamptz`;

/** Queued and still in time, or sent: the computer may still act on it. */
const pending = (now: Date) =>
  or(
    and(eq(restores.state, "queued"), inTime(now)),
    eq(restores.state, "sent"),
  );

/** Whether the run's stored messages include the checkpoint it took before its turn. */
const readTookCheckpoint = async (
  db: Pick<DesktopRunnerDb, "select">,
  runId: string,
) => {
  const [taken] = await db
    .select({ seq: events.seq })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        eq(events.type, "run.event"),
        sql`${events.message} -> 'chunk' ->> 'type' = 'CUSTOM'`,
        sql`${events.message} -> 'chunk' ->> 'name' = ${DESKTOP_RUNNER_CHECKPOINT_EVENT}`,
        sql`${events.message} -> 'chunk' -> 'value' ->> 'status' = 'taken'`,
      ),
    )
    .limit(1);
  return taken !== undefined;
};

type ThreadOf = { owner: RunOwner; threadId: SafeId<"chatThread"> };
type TurnOptions = ThreadOf & { turnId: SafeId<"chatTurn"> };

const ownedBy = (owner: RunOwner) =>
  and(
    eq(restores.userId, owner.userId),
    eq(restores.organizationId, owner.organizationId),
  );

/** The newest run the owner's turn started, and whether it took a checkpoint. */
const readTurnRun = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId, turnId }: TurnOptions,
) => {
  const [run] = await db
    .select({
      runId: runs.runId,
      state: runs.state,
      desktopId: runs.desktopId,
    })
    .from(runs)
    .where(
      and(
        eq(runs.userId, owner.userId),
        eq(runs.organizationId, owner.organizationId),
        eq(runs.chatThreadId, threadId),
        eq(runs.chatTurnId, turnId),
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.runId))
    .limit(1);
  if (run === undefined) {
    return null;
  }
  return { ...run, tookCheckpoint: await readTookCheckpoint(db, run.runId) };
};

/** The turn's newest restore, if any. */
const readTurnRestore = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId, turnId }: TurnOptions,
): Promise<StoredRestore | null> => {
  const [row] = await db
    .select(restoreColumns)
    .from(restores)
    .where(
      and(
        ownedBy(owner),
        eq(restores.chatThreadId, threadId),
        eq(restores.chatTurnId, turnId),
      ),
    )
    .orderBy(desc(restores.createdAt), desc(restores.id))
    .limit(1);
  return row ?? null;
};

const readOwnedTurn = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId, turnId }: TurnOptions,
) => {
  const [turn] = await db
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.id, turnId),
        eq(chatTurns.threadId, threadId),
        eq(chatTurns.userId, owner.userId),
        eq(chatTurns.organizationId, owner.organizationId),
      ),
    )
    .limit(1);
  return turn ?? null;
};

export type TurnFolderRestore = {
  /** Whether the turn's run finished after taking a checkpoint. */
  readonly undoable: boolean;
  /** The turn's newest restore; `null` when none was asked for. */
  readonly restore: FolderRestoreView | null;
};

/** Where a turn's undo stands; `null` for a turn that is not the owner's. */
export const readTurnFolderRestore = async (
  db: Pick<DesktopRunnerDb, "select">,
  options: TurnOptions & { now: Date },
): Promise<TurnFolderRestore | null> => {
  const turn = await readOwnedTurn(db, options);
  if (turn === null) {
    return null;
  }
  const run = await readTurnRun(db, options);
  const restore = await readTurnRestore(db, options);
  // As the undo itself decides: only the thread's newest turn is undone.
  const newest = await readIsNewestTurn(db, options);
  return {
    undoable: newest && run?.state === "finished" && run.tookCheckpoint,
    restore: restore === null ? null : viewOf(restore, options.now),
  };
};

export type RequestedFolderRestore =
  /** Queued now; its computer's socket is rung. */
  | { type: "queued"; restore: FolderRestoreView; holder: RunHolder }
  /** The turn's restore that is still going or done, answered again. */
  | { type: "existing"; restore: FolderRestoreView }
  /** The endpoint's refusals, or no such turn of the member. */
  | { type: "refused"; reason: "not_found" | ChatLocalFilesUndoRefusal };

type RequestOptions = TurnOptions & {
  restoreId: string;
  now: Date;
  /** Only a computer seen since then counts as connected. */
  seenSince: Date;
  /** How long a queued request waits for the computer's socket. */
  expiresInMs: number;
};

/** Whether a turn or run of the thread is still going. */
const readThreadBusy = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId }: ThreadOf,
) => {
  const [turn] = await db
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.threadId, threadId),
        notInArray(chatTurns.status, CHAT_TURN_RUN_ENDING_STATUSES),
      ),
    )
    .limit(1);
  if (turn !== undefined) {
    return true;
  }
  const [run] = await db
    .select({ runId: runs.runId })
    .from(runs)
    .where(
      and(
        eq(runs.userId, owner.userId),
        eq(runs.organizationId, owner.organizationId),
        eq(runs.chatThreadId, threadId),
        inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
      ),
    )
    .limit(1);
  return run !== undefined;
};

/**
 * Whether the turn is the newest of the owner's in the thread, in the order
 * turns were accepted (`NEWEST_CHAT_TURN_FIRST`).
 */
const readIsNewestTurn = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId, turnId }: TurnOptions,
) => {
  const [newest] = await db
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.organizationId, owner.organizationId),
        eq(chatTurns.userId, owner.userId),
        eq(chatTurns.threadId, threadId),
      ),
    )
    .orderBy(...NEWEST_CHAT_TURN_FIRST)
    .limit(1);
  return newest?.id === turnId;
};

/**
 * Queue an undo of the turn's file changes, or answer why not. Only the newest
 * turn of the thread is undone, only once its run finished after taking a
 * checkpoint, only while nothing else runs in the thread, and only while the
 * run's computer is connected: a request never waits for a computer that is
 * away. Asking again while one is queued, sent or done answers that one.
 * Serialized per member with the runner capacity lock.
 */
export const requestFolderRestore = async (
  db: DesktopRunnerDb,
  options: RequestOptions,
): Promise<RequestedFolderRestore> =>
  await withAggregateTransaction(
    db,
    async (tx): Promise<RequestedFolderRestore> => {
      const { owner, threadId, turnId, now } = options;
      await withAggregateLock({
        aggregate: "desktopRunnerCapacity",
        id: { organizationId: owner.organizationId, userId: owner.userId },
        tx,
      });
      const turn = await readOwnedTurn(tx, options);
      if (turn === null) {
        return { type: "refused", reason: "not_found" };
      }
      const existing = await readTurnRestore(tx, options);
      if (existing !== null && lapsed(existing, now)) {
        // Past its time: expire it, so the turn may be asked again.
        await transitionLifecycle({
          tx,
          spec: DESKTOP_RUNNER_FOLDER_RESTORE_TRANSITIONS,
          id: existing.id,
          moves: { state: { from: ["queued"], to: "expired" } },
          guard: lapsedAt(now),
          set: { settledAt: existing.expiresAt },
          recordTransitionAuditEvent: skipRestoreAudit,
        });
      } else if (
        existing !== null &&
        (existing.state === "queued" ||
          existing.state === "sent" ||
          existing.state === "restored")
      ) {
        return { type: "existing", restore: viewOf(existing, now) };
      }
      if (!(await readIsNewestTurn(tx, options))) {
        return { type: "refused", reason: "not_newest" };
      }
      if (await readThreadBusy(tx, options)) {
        return { type: "refused", reason: "thread_busy" };
      }
      const run = await readTurnRun(tx, options);
      if (run?.state !== "finished" || !run.tookCheckpoint) {
        return { type: "refused", reason: "no_checkpoint" };
      }
      const [online] = await tx
        .select({
          deviceJkt: runner.deviceJkt,
          sessionId: runner.sessionId,
          instanceId: runner.instanceId,
          protocol: runner.protocol,
        })
        .from(runner)
        .where(
          and(
            eq(runner.userId, owner.userId),
            eq(runner.organizationId, owner.organizationId),
            eq(runner.desktopId, run.desktopId),
            eq(runner.connection, "connected"),
            sql`${runner.lastSeenAt} >= ${options.seenSince}::timestamptz`,
          ),
        )
        // Another device key may name the same installation; the newest wins,
        // as when a run is assigned.
        .orderBy(desc(runner.lastSeenAt))
        .limit(1);
      if (online === undefined) {
        return { type: "refused", reason: "desktop_offline" };
      }
      // A desktop app from before restores runs turns, but is never sent one.
      if (online.protocol < DESKTOP_RUNNER_FOLDER_RESTORE_PROTOCOL) {
        return { type: "refused", reason: "desktop_update_required" };
      }
      // audit: skip - the endpoint that asks for the restore audits it
      await tx.insert(restores).values({
        id: options.restoreId,
        userId: owner.userId,
        organizationId: owner.organizationId,
        chatThreadId: threadId,
        chatTurnId: turnId,
        runId: run.runId,
        desktopId: run.desktopId,
        deviceJkt: online.deviceJkt,
        state: "queued",
        createdAt: now,
        expiresAt: new Date(now.getTime() + options.expiresInMs),
      });
      return {
        type: "queued",
        restore: {
          restoreId: options.restoreId,
          state: "queued",
          reason: null,
        },
        holder: { sessionId: online.sessionId, instanceId: online.instanceId },
      };
    },
  );

/** A restore a socket sends: what `folder.restore` carries. */
export type FolderRestoreToSend = {
  readonly restoreId: string;
  readonly folderId: string;
  /** The folder linked on the computer the run worked in, if any. */
  readonly linkedFolderId: string | null;
  readonly runId: string;
};

type ClaimOptions = {
  binding: RunnerBinding;
  sessionId: string;
  now: Date;
  /** Also those sent before and not answered: a new socket sends them again. */
  resendSent: boolean;
  /** Restores one claim sends at most; the rest go with the next delivery. */
  limit: number;
};

const ofComputer = (binding: RunnerBinding): SQL =>
  and(
    eq(restores.userId, binding.userId),
    eq(restores.organizationId, binding.organizationId),
    eq(restores.desktopId, binding.desktopId),
    eq(restores.deviceJkt, binding.deviceJkt),
  ) ?? panic("A computer's restores are named by its binding");

/**
 * The restores of device keys a relink retired, queued or sent, end as
 * expired: no socket of those keys takes or answers one again, and a sent
 * one would otherwise block the thread's runs on that computer forever.
 */
export const expireFolderRestoresOfKeys = async (
  tx: Parameters<typeof transitionLifecycleBatch>[0]["tx"] &
    Pick<DesktopRunnerDb, "select">,
  {
    owner,
    desktopId,
    deviceJkts,
    now,
  }: {
    owner: RunOwner;
    desktopId: string;
    deviceJkts: readonly string[];
    now: Date;
  },
) => {
  const ofKeys = and(
    eq(restores.userId, owner.userId),
    eq(restores.organizationId, owner.organizationId),
    eq(restores.desktopId, desktopId),
    inArray(restores.deviceJkt, [...deviceJkts]),
  );
  const unsettled = await tx
    .select({ id: restores.id })
    .from(restores)
    .where(and(ofKeys, inArray(restores.state, ["queued", "sent"])));
  await transitionLifecycleBatch({
    tx,
    spec: DESKTOP_RUNNER_FOLDER_RESTORE_TRANSITIONS,
    ids: unsettled.map(({ id }) => id),
    moves: { state: { from: ["queued", "sent"], to: "expired" } },
    guard: ofKeys ?? panic("A key's restores are named by its account"),
    set: { settledAt: now },
    recordTransitionAuditEvent: skipRestoreAudit,
  });
};

/**
 * The restores this socket sends now: queued ones still in time, marked sent
 * before they go out, and on a new socket the sent ones not answered yet. A
 * queued one past its time is expired instead. Only the computer's current
 * socket claims any.
 */
export const claimFolderRestores = async (
  db: DesktopRunnerDb,
  { binding, sessionId, now, resendSent, limit }: ClaimOptions,
): Promise<FolderRestoreToSend[]> =>
  await withAggregateTransaction(
    db,
    async (tx): Promise<FolderRestoreToSend[]> => {
      const [current] = await tx
        .select({ protocol: runner.protocol })
        .from(runner)
        .where(
          and(
            eq(runner.userId, binding.userId),
            eq(runner.organizationId, binding.organizationId),
            eq(runner.desktopId, binding.desktopId),
            eq(runner.deviceJkt, binding.deviceJkt),
            eq(runner.sessionId, sessionId),
          ),
        )
        .limit(1);
      // Only the computer's current socket sends restores, and only one that
      // speaks them; an older desktop keeps its restores until it updates.
      if (
        current === undefined ||
        current.protocol < DESKTOP_RUNNER_FOLDER_RESTORE_PROTOCOL
      ) {
        return [];
      }
      const stale = await tx
        .select({ id: restores.id })
        .from(restores)
        .where(
          and(ofComputer(binding), eq(restores.state, "queued"), lapsedAt(now)),
        )
        .limit(limit);
      if (stale.length > 0) {
        // Expired as this socket found them; the next claim takes any more.
        await transitionLifecycleBatch({
          tx,
          spec: DESKTOP_RUNNER_FOLDER_RESTORE_TRANSITIONS,
          ids: stale.map(({ id }) => id),
          moves: { state: { from: ["queued"], to: "expired" } },
          guard: lapsedAt(now),
          set: { settledAt: now },
          recordTransitionAuditEvent: skipRestoreAudit,
        });
      }
      const due = await tx
        .select({
          id: restores.id,
          state: restores.state,
          folderId: restores.chatThreadId,
          runId: restores.runId,
          linkedFolderId: desktopRunnerRuns.linkedFolderId,
        })
        .from(restores)
        .innerJoin(
          desktopRunnerRuns,
          eq(desktopRunnerRuns.runId, restores.runId),
        )
        .where(
          and(
            ofComputer(binding),
            resendSent
              ? pending(now)
              : and(eq(restores.state, "queued"), inTime(now)),
          ),
        )
        .orderBy(restores.createdAt, restores.id)
        .limit(limit);
      const queued = due
        .filter(({ state }) => state === "queued")
        .map(({ id }) => id);
      const sent =
        queued.length === 0
          ? []
          : await transitionLifecycleBatch({
              tx,
              spec: DESKTOP_RUNNER_FOLDER_RESTORE_TRANSITIONS,
              ids: queued,
              moves: { state: { from: ["queued"], to: "sent" } },
              guard: inTime(now),
              set: {},
              recordTransitionAuditEvent: skipRestoreAudit,
            });
      return due
        .filter(({ id, state }) => state === "sent" || sent.includes(id))
        .map(({ id, folderId, linkedFolderId, runId }) => ({
          restoreId: id,
          folderId,
          linkedFolderId,
          runId,
        }));
    },
  );

type SettleOptions = {
  binding: RunnerBinding;
  restoreId: string;
  outcome: DesktopRunnerFolderRestoreOutcome;
  now: Date;
};

/**
 * Record the computer's answer to a restore it was sent. Only the computer the
 * restore was for settles it, and only once: a repeated or unknown answer
 * changes nothing. An answer settles a sent restore past its time too: the
 * computer acted on it.
 */
export const settleFolderRestore = async (
  db: DesktopRunnerDb,
  { binding, restoreId, outcome, now }: SettleOptions,
): Promise<"settled" | "unknown"> =>
  await withAggregateTransaction(db, async (tx) => {
    // Serialized with run admission, which reads the restores to note.
    await withAggregateLock({
      aggregate: "desktopRunnerCapacity",
      id: { organizationId: binding.organizationId, userId: binding.userId },
      tx,
    });
    const to = outcome === "restored" ? "restored" : "refused";
    const settled = await transitionLifecycle({
      tx,
      spec: DESKTOP_RUNNER_FOLDER_RESTORE_TRANSITIONS,
      id: restoreId,
      moves: { state: { from: ["sent"], to } },
      guard: ofComputer(binding),
      set: { reason: outcome === "restored" ? null : outcome, settledAt: now },
      recordTransitionAuditEvent: skipRestoreAudit,
    });
    if (settled.type !== "transitioned") {
      return "unknown";
    }
    if (to === "restored") {
      // The lasting marker rides on the turn's answer, in the same
      // transaction: the page renders it from the message it already reads,
      // after newer turns and a move to the cloud alike. Only the server
      // writes this key; incoming client metadata never carries it.
      const marker = {
        [CHAT_LOCAL_FILES_UNDONE_METADATA_KEY]: {
          at: now.toISOString(),
        } satisfies ChatLocalFilesUndone,
      };
      // At most one row: the turn's answer.
      const [answer] = await tx
        .update(chatMessages)
        .set({
          content: sql`jsonb_set(${chatMessages.content}, '{metadata}', coalesce(${chatMessages.content} -> 'metadata', '{}'::jsonb) || ${JSON.stringify(marker)}::text::jsonb)`,
        })
        .where(
          eq(
            chatMessages.id,
            sql`(select ${chatTurns.assistantMessageId} from ${chatTurns} join ${restores} on ${restores.chatTurnId} = ${chatTurns.id} where ${restores.id} = ${restoreId})`,
          ),
        )
        .returning({
          id: chatMessages.id,
          workspaceId: chatMessages.workspaceId,
        });
      if (answer === undefined) {
        // A turn stopped before it answered keeps no answer to mark; the
        // restore still settles, and the folder is back as it was.
        logger.info("desktop_runner.folder_restore.no_answer_to_mark", {
          "desktop_runner.restore_id": restoreId,
        });
        return "settled";
      }
      // The computer, not the member, changed the answer: the desktop
      // runner records it on the member's behalf.
      const recordAuditEvent = createBackgroundAuditRecorder({
        execution: {
          performer: {
            type: "service",
            id: "desktop-runner",
            name: "Desktop runner",
          },
          trigger: {
            type: "system",
            source: "folder_restore",
            sourceId: restoreId,
          },
        },
        organizationId: binding.organizationId,
        userId: binding.userId,
        workspaceId: null,
      });
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
        resourceId: answer.id,
        workspaceId: answer.workspaceId,
        metadata: { reason: "local_files_undone", undoId: restoreId },
      });
    }
    return "settled";
  });

type QueuedSessionsOptions = {
  instanceId: string;
  now: Date;
  limit: number;
};

/**
 * The sockets this API task holds whose computer has a restore queued and in
 * time: a sweep sends them in case a doorbell ring was lost.
 */
export const readSessionsWithQueuedFolderRestores = async (
  db: Pick<DesktopRunnerDb, "select">,
  { instanceId, now, limit }: QueuedSessionsOptions,
): Promise<string[]> =>
  (
    await db
      .select({ sessionId: runner.sessionId })
      .from(runner)
      .where(
        and(
          eq(runner.instanceId, instanceId),
          eq(runner.connection, "connected"),
          gte(runner.protocol, DESKTOP_RUNNER_FOLDER_RESTORE_PROTOCOL),
          sql`exists (
            select 1 from ${restores}
            where ${restores.userId} = ${runner.userId}
              and ${restores.organizationId} = ${runner.organizationId}
              and ${restores.desktopId} = ${runner.desktopId}
              and ${restores.deviceJkt} = ${runner.deviceJkt}
              and ${restores.state} = 'queued'
              and ${restores.expiresAt} > ${now}::timestamptz
          )`,
        ),
      )
      .limit(limit)
  ).map(({ sessionId }) => sessionId);

type PendingOnComputerOptions = ThreadOf & {
  desktopId: string;
  deviceJkt: string;
  now: Date;
};

/**
 * Whether the thread has a restore that this computer may still act on: no
 * run starts in the chat's folder there meanwhile. Only the computer a
 * restore was sent to holds that folder, and it is sent the restore again on
 * every new socket until it answers, so a sent restore keeps blocking runs
 * there until then. A run on another computer works in that computer's own
 * folder and is never blocked.
 */
export const hasPendingFolderRestore = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId, desktopId, deviceJkt, now }: PendingOnComputerOptions,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: restores.id })
    .from(restores)
    .where(
      and(
        ownedBy(owner),
        eq(restores.chatThreadId, threadId),
        eq(restores.desktopId, desktopId),
        eq(restores.deviceJkt, deviceJkt),
        pending(now),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/**
 * Whether the thread's folder was restored and no accepted run was told yet.
 * A run that carried the note but was refused or lost before the computer
 * accepted it told nobody, so the next run carries it again.
 */
export const hasUnnotedFolderRestore = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId }: ThreadOf,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: restores.id })
    .from(restores)
    .where(
      and(
        ownedBy(owner),
        eq(restores.chatThreadId, threadId),
        eq(restores.state, "restored"),
        isNull(restores.notedAt),
      ),
    )
    .limit(1);
  return row !== undefined;
};

/** Record that run `runId`'s request carries the note about the thread's restores. */
export const carryFolderRestoreNotes = async (
  db: Pick<DesktopRunnerDb, "update">,
  { owner, threadId, runId }: ThreadOf & { runId: string },
): Promise<void> => {
  // audit: skip - bookkeeping of the note a run's request carries
  await db
    .update(restores)
    .set({ notedRunId: runId })
    .where(
      and(
        ownedBy(owner),
        eq(restores.chatThreadId, threadId),
        eq(restores.state, "restored"),
        isNull(restores.notedAt),
      ),
    );
};

/** The computer accepted run `runId`: the restore notes it carried are told. */
export const markFolderRestoreNotesTold = async (
  db: Pick<DesktopRunnerDb, "update">,
  { runId, now }: { runId: string; now: Date },
): Promise<void> => {
  // audit: skip - bookkeeping of the note a run's request carried
  await db
    .update(restores)
    .set({ notedAt: now })
    .where(and(eq(restores.notedRunId, runId), isNull(restores.notedAt)));
};
