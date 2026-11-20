import { panic } from "better-result";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  CHAT_LOCAL_FILES_UNDONE_METADATA_KEY,
  type ChatLocalFilesUndoComputerRefusal,
  type ChatLocalFilesUndoConversation,
  type ChatLocalFilesUndoFiles,
  type ChatLocalFilesUndone,
  type ChatLocalFilesUndoRefusal,
  type ChatLocalFilesUndoState,
} from "@stll/api-contract/chat-local-files-undo";
import {
  DESKTOP_RUNNER_CHECKPOINT_EVENT,
  DESKTOP_RUNNER_CHECKPOINTS_KEPT,
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
import { readBounded } from "@/api/lib/db/read-bounded";
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

/** Runs that took the checkpoint they were asked for before their turn. */
const tookCheckpoint = (runId: SQLWrapper) =>
  sql<boolean>`exists (select 1 from ${events} where ${events.runId} = ${runId} and ${events.type} = 'run.event' and ${events.message} -> 'chunk' ->> 'type' = 'CUSTOM' and ${events.message} -> 'chunk' ->> 'name' = ${DESKTOP_RUNNER_CHECKPOINT_EVENT} and ${events.message} -> 'chunk' -> 'value' ->> 'status' = 'taken')`;

/**
 * A run that may have worked in its folder: one the computer refused, or
 * lost before it reached the computer, never touched it.
 */
const mayHaveTouchedFolder = and(
  ne(runs.state, "rejected"),
  or(isNull(runs.lostReason), ne(runs.lostReason, "not_reached")),
);

type ThreadOf = { owner: RunOwner; threadId: SafeId<"chatThread"> };
type MessageOptions = ThreadOf & { messageId: SafeId<"chatMessage"> };

const ownedBy = (owner: RunOwner) =>
  and(
    eq(restores.userId, owner.userId),
    eq(restores.organizationId, owner.organizationId),
  );

type MessageTurn = { id: SafeId<"chatTurn"> };

/**
 * The owner's current turn of message `messageId`: the newest turn that asked
 * it (an edit keeps the message id and asks it again). `null` when the
 * message is not one of the owner's in the thread.
 */
const readMessageTurn = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId, messageId }: MessageOptions,
): Promise<MessageTurn | null> => {
  const [turn] = await db
    .select({ id: chatTurns.id })
    .from(chatTurns)
    .where(
      and(
        eq(chatTurns.threadId, threadId),
        eq(chatTurns.userMessageId, messageId),
        eq(chatTurns.userId, owner.userId),
        eq(chatTurns.organizationId, owner.organizationId),
      ),
    )
    .orderBy(...NEWEST_CHAT_TURN_FIRST)
    .limit(1);
  return turn ?? null;
};

/**
 * The thread's turns from `turn` on, by the order they were accepted (their
 * ordinal, read in the database). A turn stored before ordinals has none
 * until the ordinal repair numbers it, and matches nothing here: no run on
 * a computer is that old.
 */
const fromTurnOn = (turn: MessageTurn): SQL =>
  sql`${chatTurns.ordinal} >= (select t.ordinal from chat_turns t where t.id = ${turn.id})`;

type UndoTarget = {
  runId: string;
  desktopId: string;
  linkedFolderId: string | null;
};

/** The same folder on the same computer as `target`'s. */
const sameFolder = (target: UndoTarget, threadId: SafeId<"chatThread">) =>
  and(
    eq(runs.desktopId, target.desktopId),
    target.linkedFolderId === null
      ? and(isNull(runs.linkedFolderId), eq(runs.chatThreadId, threadId))
      : eq(runs.linkedFolderId, target.linkedFolderId),
  );

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

type Assessment =
  /** No turn from the message on worked in a folder on a computer. */
  | { type: "none" }
  /** The run whose checkpoint an undo restores, and why it cannot now. */
  | {
      type: "refused";
      targetRunId: string;
      reason: ChatLocalFilesUndoRefusal;
    }
  /** The run whose checkpoint is restored, and its computer's socket. */
  | {
      type: "ready";
      target: UndoTarget;
      online: {
        deviceJkt: string;
        sessionId: string;
        instanceId: string;
      };
    };

type AssessOptions = ThreadOf & {
  turn: MessageTurn;
  /** Only a computer seen since then counts as connected. */
  seenSince: Date;
};

/** The runs of the thread from the message's turn on that may have touched a folder. */
const fromTurnOf = ({
  owner,
  threadId,
  turn,
}: ThreadOf & { turn: MessageTurn }) =>
  and(
    eq(runs.userId, owner.userId),
    eq(runs.organizationId, owner.organizationId),
    eq(runs.chatThreadId, threadId),
    mayHaveTouchedFolder,
    fromTurnOn(turn),
  );

type FoundTarget = UndoTarget & { tookCheckpoint: boolean };

/**
 * The run whose checkpoint an undo from the message restores: the first run
 * from the message's turn on that may have worked in a folder.
 */
const readUndoTarget = async (
  db: Pick<DesktopRunnerDb, "select">,
  options: ThreadOf & { turn: MessageTurn },
): Promise<FoundTarget | null> => {
  const [target] = await db
    .select({
      runId: runs.runId,
      desktopId: runs.desktopId,
      linkedFolderId: runs.linkedFolderId,
      tookCheckpoint: tookCheckpoint(runs.runId),
    })
    .from(runs)
    .innerJoin(chatTurns, eq(chatTurns.id, runs.chatTurnId))
    .where(fromTurnOf(options))
    .orderBy(asc(runs.createdAt), asc(runs.runId))
    .limit(1);
  return target ?? null;
};

/**
 * Whether the files changed since the message's turn can be undone, and
 * from which checkpoint: the one the first run from that turn on took before
 * it worked in its folder. Restoring it undoes that run and every later one.
 */
const assessUndo = async (
  db: Pick<DesktopRunnerDb, "select">,
  options: AssessOptions & { target?: FoundTarget | null },
): Promise<Assessment> => {
  const { owner, threadId, seenSince } = options;
  const fromTurn = fromTurnOf(options);
  const target =
    options.target === undefined
      ? await readUndoTarget(db, options)
      : options.target;
  if (target === null) {
    return { type: "none" };
  }
  if (await readThreadBusy(db, { owner, threadId })) {
    return {
      type: "refused",
      targetRunId: target.runId,
      reason: "thread_busy",
    };
  }
  const [elsewhere] = await db
    .select({ runId: runs.runId })
    .from(runs)
    .innerJoin(chatTurns, eq(chatTurns.id, runs.chatTurnId))
    .where(
      and(
        fromTurn,
        or(
          ne(runs.desktopId, target.desktopId),
          sql`${runs.linkedFolderId} IS DISTINCT FROM ${target.linkedFolderId}::uuid`,
        ),
      ),
    )
    .limit(1);
  if (elsewhere !== undefined) {
    return {
      type: "refused",
      targetRunId: target.runId,
      reason: "several_folders",
    };
  }
  if (target.linkedFolderId !== null) {
    // A linked folder is the member's own: another chat that worked in it
    // since would lose its changes too. That covers a run of another chat
    // that started earlier and still worked after this run's checkpoint: one
    // still open, or one whose last word (an event or its end, each of which
    // moves `updated_at`) came after this run started.
    const [shared] = await db
      .select({ runId: runs.runId })
      .from(runs)
      .where(
        and(
          eq(runs.userId, owner.userId),
          eq(runs.organizationId, owner.organizationId),
          sameFolder(target, threadId),
          sql`${runs.chatThreadId} IS DISTINCT FROM ${threadId}::uuid`,
          // sql-perf-allow: bounded by the indexed runs of one member on one computer (desktop_runner_runs_runner_state_idx), which pruneEndedRuns keeps few; the subquery reads one run by primary key
          or(
            inArray(runs.state, DESKTOP_RUNNER_OPEN_RUN_STATES),
            sql`${runs.updatedAt} > (select r.created_at from desktop_runner_runs r where r.run_id = ${target.runId})`,
          ),
          mayHaveTouchedFolder,
        ),
      )
      .limit(1);
    if (shared !== undefined) {
      return {
        type: "refused",
        targetRunId: target.runId,
        reason: "folder_shared",
      };
    }
  }
  // An earlier undo restored a checkpoint taken at or before this one, after
  // this run: these changes are gone, and restoring this checkpoint now would
  // bring back what that undo took away.
  const [undoneBefore] = await db
    .select({ id: restores.id })
    .from(restores)
    .innerJoin(runs, eq(runs.runId, restores.runId))
    .where(
      and(
        ownedBy(owner),
        eq(restores.state, "restored"),
        sameFolder(target, threadId),
        ne(runs.runId, target.runId),
        sql`${runs.createdAt} <= (select r.created_at from desktop_runner_runs r where r.run_id = ${target.runId})`,
        sql`${restores.createdAt} > (select r.created_at from desktop_runner_runs r where r.run_id = ${target.runId})`,
      ),
    )
    .limit(1);
  if (undoneBefore !== undefined) {
    return {
      type: "refused",
      targetRunId: target.runId,
      reason: "already_undone",
    };
  }
  if (!target.tookCheckpoint) {
    return {
      type: "refused",
      targetRunId: target.runId,
      reason: "no_checkpoint",
    };
  }
  // The computer keeps the newest checkpoints of a folder only: with as many
  // later ones as it keeps, this one is gone.
  const later = await readBounded(
    db
      .select({ runId: runs.runId })
      .from(runs)
      .where(
        and(
          eq(runs.userId, owner.userId),
          eq(runs.organizationId, owner.organizationId),
          sameFolder(target, threadId),
          sql`${runs.createdAt} > (select r.created_at from desktop_runner_runs r where r.run_id = ${target.runId})`,
          tookCheckpoint(runs.runId),
        ),
      ),
    DESKTOP_RUNNER_CHECKPOINTS_KEPT - 1,
  );
  if (later.type === "overflow") {
    return {
      type: "refused",
      targetRunId: target.runId,
      reason: "no_checkpoint",
    };
  }
  const [online] = await db
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
        eq(runner.desktopId, target.desktopId),
        eq(runner.connection, "connected"),
        sql`${runner.lastSeenAt} >= ${seenSince}::timestamptz`,
      ),
    )
    // Another device key may name the same installation; the newest wins,
    // as when a run is assigned.
    .orderBy(desc(runner.lastSeenAt))
    .limit(1);
  if (online === undefined) {
    return {
      type: "refused",
      targetRunId: target.runId,
      reason: "desktop_offline",
    };
  }
  // A desktop app from before restores runs turns, but is never sent one.
  if (online.protocol < DESKTOP_RUNNER_FOLDER_RESTORE_PROTOCOL) {
    return {
      type: "refused",
      targetRunId: target.runId,
      reason: "desktop_update_required",
    };
  }
  return {
    type: "ready",
    target: {
      runId: target.runId,
      desktopId: target.desktopId,
      linkedFolderId: target.linkedFolderId,
    },
    online: {
      deviceJkt: online.deviceJkt,
      sessionId: online.sessionId,
      instanceId: online.instanceId,
    },
  };
};

/** The newest restore of the run's checkpoint, if any. */
const readRunRestore = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, runId }: { owner: RunOwner; runId: string },
): Promise<StoredRestore | null> => {
  const [row] = await db
    .select(restoreColumns)
    .from(restores)
    .where(and(ownedBy(owner), eq(restores.runId, runId)))
    .orderBy(desc(restores.createdAt), desc(restores.id))
    .limit(1);
  return row ?? null;
};

/**
 * Whether the answer right before the message ended a turn whose run did not
 * finish its work: a session does not continue from such a turn, so an edit
 * of the message starts the agent over from the chat's text.
 */
const readPreviousNotFinished = async (
  db: Pick<DesktopRunnerDb, "select">,
  { owner, threadId, messageId }: MessageOptions,
) => {
  const previous = db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        sql`(${chatMessages.createdAt}, ${chatMessages.id}) < (select m.created_at, m.id from chat_messages m where m.id = ${messageId} and m.thread_id = ${threadId})`,
      ),
    )
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(1);
  const [run] = await db
    .select({ state: runs.state, outcome: runs.outcome })
    .from(runs)
    .innerJoin(chatTurns, eq(chatTurns.id, runs.chatTurnId))
    .where(
      and(
        eq(runs.userId, owner.userId),
        eq(runs.organizationId, owner.organizationId),
        eq(runs.chatThreadId, threadId),
        eq(chatTurns.assistantMessageId, sql`(${previous})`),
        mayHaveTouchedFolder,
      ),
    )
    .orderBy(desc(runs.createdAt), desc(runs.runId))
    .limit(1);
  return (
    run !== undefined &&
    (run.state !== "finished" || run.outcome !== "completed")
  );
};

export type MessageFolderRestore = {
  readonly files: ChatLocalFilesUndoFiles;
  readonly conversation: ChatLocalFilesUndoConversation;
  /** The restore of the checkpoint the undo would restore; `null` when none was asked for. */
  readonly restore: FolderRestoreView | null;
};

type ReadOptions = MessageOptions & { now: Date; seenSince: Date };

/**
 * What editing the chat from message `messageId` does on the member's
 * computer; `null` for a message that is not the owner's.
 */
export const readMessageFolderRestore = async (
  db: Pick<DesktopRunnerDb, "select">,
  options: ReadOptions,
): Promise<MessageFolderRestore | null> => {
  const turn = await readMessageTurn(db, options);
  if (turn === null) {
    return null;
  }
  const conversation: ChatLocalFilesUndoConversation =
    (await readPreviousNotFinished(db, options))
      ? { type: "restarts", reason: "previous_not_finished" }
      : { type: "continues" };
  const assessed = await assessUndo(db, { ...options, turn });
  switch (assessed.type) {
    case "none":
      return { files: { type: "none" }, conversation, restore: null };
    case "refused": {
      // An undo asked before still answers for itself: one that restored
      // the folder stays done while the computer is away.
      const restore = await readRunRestore(db, {
        owner: options.owner,
        runId: assessed.targetRunId,
      });
      return {
        files: { type: "unavailable", reason: assessed.reason },
        conversation,
        restore: restore === null ? null : viewOf(restore, options.now),
      };
    }
    case "ready": {
      const restore = await readRunRestore(db, {
        owner: options.owner,
        runId: assessed.target.runId,
      });
      return {
        files: { type: "available" },
        conversation,
        restore: restore === null ? null : viewOf(restore, options.now),
      };
    }
    default:
      assessed satisfies never;
      return panic("Unknown local files undo assessment");
  }
};

export type RequestedFolderRestore =
  /** Queued now; its computer's socket is rung. */
  | { type: "queued"; restore: FolderRestoreView; holder: RunHolder }
  /** The restore of the same checkpoint that is still going or done, answered again. */
  | { type: "existing"; restore: FolderRestoreView }
  /** The endpoint's refusals, or no such message of the member. */
  | { type: "refused"; reason: "not_found" | ChatLocalFilesUndoRefusal };

type RequestOptions = ReadOptions & {
  restoreId: string;
  /** How long a queued request waits for the computer's socket. */
  expiresInMs: number;
};

/**
 * Queue an undo of the file changes made since message `messageId`, or answer
 * why not (`assessUndo`). A request never waits for a computer that is away.
 * Asking again while the same checkpoint's restore is queued, sent or done
 * answers that one. Serialized per member with the runner capacity lock.
 */
export const requestFolderRestore = async (
  db: DesktopRunnerDb,
  options: RequestOptions,
): Promise<RequestedFolderRestore> =>
  await withAggregateTransaction(
    db,
    async (tx): Promise<RequestedFolderRestore> => {
      const { owner, threadId, now } = options;
      await withAggregateLock({
        aggregate: "desktopRunnerCapacity",
        id: { organizationId: owner.organizationId, userId: owner.userId },
        tx,
      });
      const turn = await readMessageTurn(tx, options);
      if (turn === null) {
        return { type: "refused", reason: "not_found" };
      }
      const found = await readUndoTarget(tx, { ...options, turn });
      if (found === null) {
        return { type: "refused", reason: "no_checkpoint" };
      }
      // The undo of this checkpoint asked before answers for itself, before
      // any check a new one needs: a repeat while the computer is away or a
      // turn runs follows the same undo.
      const existing = await readRunRestore(tx, {
        owner,
        runId: found.runId,
      });
      if (existing !== null && lapsed(existing, now)) {
        // Past its time: expire it, so the checkpoint may be asked again.
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
      const assessed = await assessUndo(tx, {
        ...options,
        turn,
        target: found,
      });
      switch (assessed.type) {
        case "none":
          return { type: "refused", reason: "no_checkpoint" };
        case "refused":
          return { type: "refused", reason: assessed.reason };
        case "ready":
          break;
        default:
          assessed satisfies never;
          return panic("Unknown local files undo assessment");
      }
      const { target, online } = assessed;
      // audit: skip - the endpoint that asks for the restore audits it
      await tx.insert(restores).values({
        id: options.restoreId,
        userId: owner.userId,
        organizationId: owner.organizationId,
        chatThreadId: threadId,
        chatTurnId: turn.id,
        runId: target.runId,
        desktopId: target.desktopId,
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
      // The lasting marker rides on the undone answers, in the same
      // transaction: the page renders it from the message it already reads,
      // after newer turns and a move to the cloud alike. Only the server
      // writes this key; incoming client metadata never carries it.
      const marker = {
        [CHAT_LOCAL_FILES_UNDONE_METADATA_KEY]: {
          at: now.toISOString(),
        } satisfies ChatLocalFilesUndone,
      };
      // The answers of the turns whose runs the restore undid: the target
      // run's and every later run's of the thread in the same folder. No
      // upper bound is needed, nor one sampled by a clock: the request found
      // no run of the thread open, and from the request until this answer
      // run admission refuses the thread's runs on this computer (folder
      // busy), under the same lock, so every such run existed at the request.
      const target = alias(runs, "target_run");
      const undoneAnswers = tx
        .select({ id: chatTurns.assistantMessageId })
        .from(restores)
        .innerJoin(target, eq(target.runId, restores.runId))
        .innerJoin(
          runs,
          and(
            eq(runs.chatThreadId, restores.chatThreadId),
            eq(runs.desktopId, target.desktopId),
            sql`${runs.linkedFolderId} IS NOT DISTINCT FROM ${target.linkedFolderId}`,
            // Read in the database, at full precision.
            sql`${runs.createdAt} >= (select t.created_at from desktop_runner_runs t where t.run_id = ${restores.runId})`,
          ),
        )
        .innerJoin(chatTurns, eq(chatTurns.id, runs.chatTurnId))
        .where(eq(restores.id, restoreId));
      const answers = await tx
        .update(chatMessages)
        .set({
          content: sql`jsonb_set(${chatMessages.content}, '{metadata}', coalesce(${chatMessages.content} -> 'metadata', '{}'::jsonb) || ${JSON.stringify(marker)}::text::jsonb)`,
        })
        .where(inArray(chatMessages.id, undoneAnswers))
        .returning({
          id: chatMessages.id,
          workspaceId: chatMessages.workspaceId,
        });
      if (answers.length === 0) {
        // Turns stopped before they answered keep no answer to mark; the
        // restore still settles, and the folder is back as it was.
        logger.info("desktop_runner.folder_restore.no_answer_to_mark", {
          "desktop_runner.restore_id": restoreId,
        });
        return "settled";
      }
      // The computer, not the member, changed the answers: the desktop
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
      // One audit row per marked answer, written together in this transaction.
      await recordAuditEvent(
        tx,
        answers.map((answer) => ({
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.CHAT_MESSAGE,
          resourceId: answer.id,
          workspaceId: answer.workspaceId,
          metadata: { reason: "local_files_undone", undoId: restoreId },
        })),
      );
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
