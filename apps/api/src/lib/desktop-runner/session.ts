import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_CLOSE,
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  DESKTOP_RUNNER_FRAME_REJECTION,
  DESKTOP_RUNNER_PROTOCOL,
  DESKTOP_RUNNER_SERVER_MESSAGE,
  type DesktopRunnerClose,
  type DesktopRunnerDesktopMessage,
  type DesktopRunnerLimits,
  type DesktopRunnerServerMessage,
  desktopRunnerServerMessageSchema,
  type DesktopRunnerTiming,
  parseDesktopRunnerFrame,
  policyViolation,
} from "@stll/api-contract/desktop-runner";

import type {
  ApiServerWebSocket,
  ApiSocketSession,
} from "@/api/http/websocket";
import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import type { DesktopKeyLiveness } from "@/api/lib/business-registries/desktop/liveness";
import { isFoldableChunk } from "@/api/lib/desktop-runner/chunk";
import type { RunnerFeatureAccess } from "@/api/lib/desktop-runner/feature-access";
import {
  claimFolderRestores,
  settleFolderRestore,
} from "@/api/lib/desktop-runner/folder-restores";
import { openRunOutputKey } from "@/api/lib/desktop-runner/output-keys";
import {
  openRunAnswer,
  storedRunAnswerSchema,
} from "@/api/lib/desktop-runner/sealed-answers";
import {
  claimRunnerSession,
  type DesktopRunnerDb,
  markRunStartsSending,
  type PendingCommand,
  persistRunMessage,
  readPendingCommands,
  recordBackgroundTasks,
  recordHarnessStatus,
  recordLinkedFolders,
  recordRunAccepted,
  recordRunRejected,
  releaseRunnerSession,
  releaseUnsentRunStarts,
  renewRunnerSession,
  type RunHolder,
  type RunnerBinding,
  type RunTransition,
  type SequencedRunMessage,
} from "@/api/lib/desktop-runner/store";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type {
  MintAgentRunTokenInput,
  MintedAgentRunToken,
} from "@/api/mcp/agent-run-token";

export type MintRunToken = (
  input: MintAgentRunTokenInput,
) => Promise<MintedAgentRunToken>;

/** The clock functions a socket schedules with. */
export type RunnerTimers = {
  readonly setTimeout: (run: () => void, ms: number) => Timer;
  readonly clearTimeout: (timer: Timer) => void;
  readonly setInterval: (run: () => void, ms: number) => Timer;
  readonly clearInterval: (timer: Timer) => void;
};

export const SYSTEM_TIMERS: RunnerTimers = {
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (timer) => {
    clearTimeout(timer);
  },
  setInterval: (run, ms) => setInterval(run, ms),
  clearInterval: (timer) => {
    clearInterval(timer);
  },
};

/** What every socket of one gateway shares. */
export type SignAttachmentLink = (file: {
  s3Key: string;
  userId: SafeId<"user">;
  organizationId: SafeId<"organization">;
}) => Promise<string>;

type RunnerSessionContext = {
  readonly db: DesktopRunnerDb;
  readonly instanceId: string;
  readonly timing: DesktopRunnerTiming;
  readonly limits: DesktopRunnerLimits;
  readonly timers: RunnerTimers;
  readonly now: () => Date;
  readonly random: () => number;
  readonly mintRunToken: MintRunToken;
  /** A short-lived link for one file a `run.start` copies. */
  readonly signAttachmentLink: SignAttachmentLink;
  /** Whether the credential that opened a socket still authorizes it. */
  readonly isKeyLive: DesktopKeyLiveness;
  /** Whether the socket's account still has the runner feature. */
  readonly isRunnerEnabled: RunnerFeatureAccess;
  /** Tell the socket a newer one replaced that it is no longer current. */
  readonly ringPrevious: (holder: RunHolder) => void;
  /** Wake the readers of a run whose stored messages or state changed. */
  readonly ringRun: (runId: string) => void;
  /** Tell the account its chats' background work here changed. */
  readonly announceBackgroundTasks: (owner: RunnerBinding) => void;
};

type RunnerSessionOptions = {
  context: RunnerSessionContext;
  binding: RunnerBinding;
  sessionId: string;
  onClosed: (sessionId: string) => void;
};

/** Frames queued behind the one being stored before the socket is refused. */
const MAX_QUEUED_FRAMES = 256;
/** Commands read from the queue per round trip. */
const COMMAND_PAGE_SIZE = 100;
/** Unanswered ping intervals before the socket is closed. */
const MAX_MISSED_PINGS = 2;
/** Upper bound of the `reconnect` delay when a socket reaches its maximum life. */
const MAX_LIFE_RECONNECT_SPREAD_MS = 5000;
/** Share of the maximum life a socket may end early, so a fleet does not reconnect at once. */
const MAX_LIFE_JITTER = 0.1;

/** A failed step closes the socket; the desktop resends after its last `ack`. */
const FRAME_SINK = failureSink({
  event: "desktop_runner.frame_failed",
  expected: [],
});
const DELIVERY_SINK = failureSink({
  event: "desktop_runner.delivery_failed",
  expected: [],
});
/** A queued command no longer reads; its run is cancelled in its place. */
const UNREADABLE_SINK = failureSink({
  event: "desktop_runner.command_unreadable",
  expected: [],
});
const HEARTBEAT_SINK = failureSink({
  event: "desktop_runner.heartbeat_failed",
  expected: [],
});

type StepKind = "frame" | "deliver" | "heartbeat";

const observeStepFailure = (kind: StepKind, error: unknown) => {
  switch (kind) {
    case "frame":
      observeFailure(error, { sink: FRAME_SINK });
      return;
    case "deliver":
      observeFailure(error, { sink: DELIVERY_SINK });
      return;
    case "heartbeat":
      observeFailure(error, { sink: HEARTBEAT_SINK });
      return;
    default: {
      kind satisfies never;
      panic("Unknown desktop runner step");
    }
  }
};
const RELEASE_SINK = failureSink({
  event: "desktop_runner.release_failed",
  expected: [],
});

type SessionPhase =
  | { type: "connecting" }
  | { type: "awaiting_hello"; socket: ApiServerWebSocket }
  | {
      type: "ready";
      socket: ApiServerWebSocket;
      /** Runs the desktop listed in `hello`; their `run.start` is not resent. */
      held: ReadonlySet<string>;
    }
  | { type: "closed" };

type TrackedToken = {
  readonly expiresAt: number;
  readonly workspaceIds: readonly SafeId<"workspace">[];
};

/** One socket's state; the functions below are its only writers. */
type SessionState = {
  readonly context: RunnerSessionContext;
  readonly binding: RunnerBinding;
  readonly sessionId: string;
  phase: SessionPhase;
  /** The step in flight; the next one starts after it. */
  chain: Promise<void>;
  queuedFrames: number;
  /** UTF-8 bytes of the frames waiting behind the one being stored. */
  queuedBytes: number;
  /** Bun buffered the last command; delivery resumes when the socket drains. */
  backpressured: boolean;
  /** The task began draining before the socket opened: the delay to send then. */
  drainOnOpen: number | null;
  queuedDelivery: Promise<void> | null;
  /** The last queued command this socket has sent. */
  deliveredThrough: number;
  /** Whether `hello` made this socket the desktop's current one. */
  claimed: boolean;
  heard: boolean;
  missedPings: number;
  /** Tokens this socket sent, refreshed before they expire. */
  readonly tokens: Map<string, TrackedToken>;
  readonly timeouts: Timer[];
  readonly intervals: Timer[];
};

const runStartPayloadSchema = v.looseObject({
  mcp: v.looseObject({}),
  attachments: v.optional(
    v.array(v.object({ path: v.string(), s3Key: v.string() })),
    [],
  ),
});

const close = (state: SessionState, reason: DesktopRunnerClose) => {
  if (state.phase.type === "closed" || state.phase.type === "connecting") {
    return;
  }
  const { socket } = state.phase;
  state.phase = { type: "closed" };
  socket.close(reason.code, reason.reason);
};

/**
 * What a send did: `backpressure` means Bun buffered the frame and the socket
 * should take no more until it drains.
 */
type Sent = "sent" | "backpressure" | "closed";

const send = (
  state: SessionState,
  message: DesktopRunnerServerMessage,
): Sent => {
  if (state.phase.type !== "awaiting_hello" && state.phase.type !== "ready") {
    return "closed";
  }
  const status = state.phase.socket.send(JSON.stringify(message));
  // 0 means Bun dropped the frame; the queue is replayed on the next socket.
  if (status === 0) {
    close(state, DESKTOP_RUNNER_CLOSE.internalError);
    return "closed";
  }
  return status === -1 ? "backpressure" : "sent";
};

const drain = (state: SessionState, afterMs: number) => {
  // An upgraded socket that has not opened yet is told as soon as it opens.
  if (state.phase.type === "connecting") {
    state.drainOnOpen = afterMs;
    return;
  }
  send(state, { type: DESKTOP_RUNNER_SERVER_MESSAGE.reconnect, afterMs });
  close(state, DESKTOP_RUNNER_CLOSE.goingAway);
};

/**
 * Run `work` after every step before it, so frames are handled in arrival
 * order and commands leave in queue order. A failure closes the socket; the
 * desktop resends what was not acknowledged.
 */
const step = async (
  state: SessionState,
  kind: StepKind,
  work: () => Promise<void>,
) => {
  const previous = state.chain;
  const run = (async () => {
    await previous;
    if (state.phase.type === "closed") {
      return;
    }
    const done = await Result.tryPromise(work);
    if (done.isErr()) {
      observeStepFailure(kind, done.error);
      close(state, DESKTOP_RUNNER_CLOSE.internalError);
    }
  })();
  state.chain = run;
  await run;
};

const mint = async (
  state: SessionState,
  runId: string,
  workspaceIds: TrackedToken["workspaceIds"],
) => {
  const minted = await state.context.mintRunToken({
    userId: state.binding.userId,
    organizationId: state.binding.organizationId,
    runId,
    workspaceIds,
  });
  state.tokens.set(runId, {
    expiresAt: minted.expiresAt.getTime(),
    workspaceIds,
  });
  return { token: minted.token, expiresAt: minted.expiresAt.toISOString() };
};

const sendToken = async (
  state: SessionState,
  runId: string,
  workspaceIds: TrackedToken["workspaceIds"],
) => {
  const { token, expiresAt } = await mint(state, runId, workspaceIds);
  send(state, {
    type: DESKTOP_RUNNER_SERVER_MESSAGE.runToken,
    runId,
    token,
    expiresAt,
  });
};

class DesktopRunnerCommandUnreadable extends TaggedError(
  "DesktopRunnerCommandUnreadable",
)<{ message: string; kind: PendingCommand["kind"] }> {}

/**
 * What a stored command is sent as. `unreadable` is a command that will
 * never read again: a stored payload that no longer validates, or answers
 * that no longer open. A failure that may pass (minting a token, a missing
 * content key) throws instead, so the socket closes and the next one tries
 * the command again.
 */
type Composed =
  | { type: "message"; message: DesktopRunnerServerMessage }
  | { type: "unreadable"; reason: string };

/**
 * A stored command as the message to send: a `run.start` with a fresh
 * token and its run's output key, a `run.answer` with its answers opened.
 */
const compose = async (
  state: SessionState,
  command: PendingCommand,
): Promise<Composed> => {
  let candidate = command.payload;
  if (command.kind === DESKTOP_RUNNER_SERVER_MESSAGE.runStart) {
    const stored = v.safeParse(runStartPayloadSchema, command.payload);
    if (!stored.success) {
      return { type: "unreadable", reason: "its MCP server does not read" };
    }
    // The socket is bound to the organization of every run it holds.
    const outputKey = await openRunOutputKey(
      state.binding.organizationId,
      command.sealedOutputKey,
    );
    if (outputKey.type === "unreadable") {
      return { type: "unreadable", reason: "its run has no output key" };
    }
    const token = await mint(state, command.runId, command.workspaceIds);
    const attachments = await Promise.all(
      stored.output.attachments.map(async ({ path, s3Key }) => ({
        path,
        url: await state.context.signAttachmentLink({
          s3Key,
          userId: state.binding.userId,
          organizationId: state.binding.organizationId,
        }),
      })),
    );
    candidate = {
      ...stored.output,
      attachments,
      mcp: { ...stored.output.mcp, ...token },
      outputKey: outputKey.outputKey,
    };
  }
  if (command.kind === DESKTOP_RUNNER_SERVER_MESSAGE.runAnswer) {
    const stored = v.safeParse(storedRunAnswerSchema, command.payload);
    // The socket is bound to the organization of every run it holds.
    const opened = stored.success
      ? await openRunAnswer(state.binding.organizationId, stored.output)
      : ({ type: "unreadable" } as const);
    if (opened.type === "unreadable") {
      return { type: "unreadable", reason: "its answers do not open" };
    }
    candidate = opened.message;
  }
  const message = v.safeParse(desktopRunnerServerMessageSchema, candidate);
  // Commands are validated when queued; one that no longer is was corrupted.
  return message.success
    ? { type: "message", message: message.output }
    : { type: "unreadable", reason: "it no longer validates" };
};

/**
 * The message a stored command leaves as. A command that no longer reads
 * cannot be sent, and skipping it would leave its run waiting on it (a
 * question whose answer never arrives) while the commands after it go out:
 * its run is cancelled instead, so the run ends and its chat turn with it.
 * The cancel is idempotent on the desktop, so a later socket that reads the
 * same command again sends the same cancel.
 */
const outgoing = async (
  state: SessionState,
  command: PendingCommand,
): Promise<DesktopRunnerServerMessage> => {
  const composed = await compose(state, command);
  if (composed.type === "message") {
    return composed.message;
  }
  observeFailure(
    new DesktopRunnerCommandUnreadable({
      message: `A queued ${command.kind} cannot be sent: ${composed.reason}`,
      kind: command.kind,
    }),
    { sink: UNREADABLE_SINK },
  );
  return {
    type: DESKTOP_RUNNER_SERVER_MESSAGE.runCancel,
    runId: command.runId,
  };
};

/** Folder restores one delivery sends at most; the next delivery sends more. */
const RESTORE_PAGE_SIZE = 100;

/**
 * Send the computer's folder restores: those queued, and on a new socket
 * (`resendSent`) those sent before that it has not answered. Each is marked
 * sent before it goes out, so a restore that expired is never sent; a frame
 * lost with its socket is sent again on the next one.
 */
const deliverRestores = async (state: SessionState, resendSent: boolean) => {
  const due = await claimFolderRestores(state.context.db, {
    binding: state.binding,
    sessionId: state.sessionId,
    now: state.context.now(),
    resendSent,
    limit: RESTORE_PAGE_SIZE,
  });
  for (const { restoreId, folderId, linkedFolderId, runId } of due) {
    const sent = send(state, {
      type: DESKTOP_RUNNER_SERVER_MESSAGE.folderRestore,
      restoreId,
      folderId,
      linkedFolderId,
      runId,
    });
    if (sent === "closed") {
      return;
    }
    if (sent === "backpressure") {
      state.backpressured = true;
    }
  }
};

type DeliverOptions = {
  /** A new socket also sends again the restores sent to an earlier one. */
  resendSent: boolean;
};

/**
 * Send the computer's folder restores, then every command queued after the
 * last one sent, page by page.
 */
const deliverPending = async (
  state: SessionState,
  { resendSent }: DeliverOptions,
) => {
  if (state.phase.type !== "ready") {
    return;
  }
  const { held } = state.phase;
  if (!state.backpressured) {
    await deliverRestores(state, resendSent);
  }
  for (;;) {
    // Commands wait in the queue, not in the socket's buffer, until it drains.
    if (state.backpressured) {
      return;
    }
    // db-await-in-loop: keyset page per iteration; the page is the batch
    const page = await deliverPage(state, held);
    if (page !== "full") {
      return;
    }
  }
};

/**
 * One page of the socket's queue: read, composed (tokens minted), then
 * checked at the send boundary and written with nothing awaited in between,
 * so a relink that retires this socket's key, or ends a run, lands before
 * the check and nothing of it goes out. A `run.start` whose run ended since
 * the read is skipped; one recorded as delivered that never went out (the
 * socket closed or filled up) is released, so it keeps the pickup window.
 * `full` when another page may follow.
 */
const deliverPage = async (
  state: SessionState,
  held: ReadonlySet<string>,
): Promise<"full" | "done"> => {
  const { db } = state.context;
  const pending = await readPendingCommands(db, {
    binding: state.binding,
    sessionId: state.sessionId,
    afterId: state.deliveredThrough,
    limit: COMMAND_PAGE_SIZE,
  });
  if (pending.type === "superseded") {
    close(state, DESKTOP_RUNNER_CLOSE.superseded);
    return "done";
  }
  const composed: {
    command: PendingCommand;
    message: DesktopRunnerServerMessage | null;
  }[] = [];
  for (const command of pending.commands) {
    const resend =
      command.kind !== DESKTOP_RUNNER_SERVER_MESSAGE.runStart ||
      !held.has(command.runId);
    composed.push({
      command,
      message: resend ? await outgoing(state, command) : null,
    });
  }
  const starts = composed.flatMap(({ command, message }) =>
    message !== null && command.kind === DESKTOP_RUNNER_SERVER_MESSAGE.runStart
      ? [command.runId]
      : [],
  );
  const now = state.context.now();
  const boundary = await markRunStartsSending(db, {
    binding: state.binding,
    sessionId: state.sessionId,
    runIds: starts,
    now,
  });
  if (boundary.type === "superseded") {
    close(state, DESKTOP_RUNNER_CLOSE.superseded);
    return "done";
  }
  const unsent = new Set(boundary.open);
  const written = (() => {
    for (const { command, message } of composed) {
      const ended =
        message !== null &&
        command.kind === DESKTOP_RUNNER_SERVER_MESSAGE.runStart &&
        !boundary.open.has(command.runId);
      const sent = message === null || ended ? "sent" : send(state, message);
      if (sent === "closed") {
        return "stopped";
      }
      unsent.delete(command.runId);
      // A buffered frame was taken; the next command waits for the drain.
      state.deliveredThrough = command.id;
      if (sent === "backpressure") {
        state.backpressured = true;
        return "stopped";
      }
    }
    return "all";
  })();
  await releaseUnsentRunStarts(db, {
    binding: state.binding,
    runIds: [...unsent],
    now,
  });
  return written === "all" && pending.commands.length === COMMAND_PAGE_SIZE
    ? "full"
    : "done";
};

const deliver = async (state: SessionState) => {
  // One queued delivery reads everything queued before it runs.
  state.queuedDelivery ??= step(state, "deliver", async () => {
    state.queuedDelivery = null;
    await deliverPending(state, { resendSent: false });
  });
  await state.queuedDelivery;
};

const closeForTransition = (state: SessionState, transition: RunTransition) => {
  switch (transition.type) {
    case "applied":
      return;
    case "unknown_run":
      close(state, DESKTOP_RUNNER_CLOSE.unknownRun);
      return;
    case "invalid_state":
      close(state, policyViolation("run_state"));
      return;
    default: {
      transition satisfies never;
      panic("Unknown desktop runner run transition");
    }
  }
};

/** Store a run message and acknowledge it, or close on what it violates. */
const storeSequenced = async (
  state: SessionState,
  message: SequencedRunMessage,
) => {
  if (
    message.type === DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent &&
    !isFoldableChunk(message.chunk)
  ) {
    close(state, policyViolation("unfoldable_chunk"));
    return;
  }
  const stored = await persistRunMessage(state.context.db, {
    binding: state.binding,
    message,
    now: state.context.now(),
    leaseMs: state.context.timing.leaseMs,
    limits: state.context.limits,
  });
  switch (stored.type) {
    case "persisted":
      if (message.type === DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished) {
        state.tokens.delete(message.runId);
      }
      state.context.ringRun(message.runId);
      send(state, {
        type: DESKTOP_RUNNER_SERVER_MESSAGE.ack,
        runId: message.runId,
        seq: stored.seq,
      });
      return;
    case "duplicate":
      // Acknowledge again, so a desktop whose ack was lost trims its outbox.
      send(state, {
        type: DESKTOP_RUNNER_SERVER_MESSAGE.ack,
        runId: message.runId,
        seq: stored.ackSeq,
      });
      return;
    case "gap":
      close(state, DESKTOP_RUNNER_CLOSE.sequenceGap);
      return;
    case "unknown_run":
      close(state, DESKTOP_RUNNER_CLOSE.unknownRun);
      return;
    case "invalid_state":
      close(state, policyViolation("run_state"));
      return;
    case "run_limit":
      // The run is lost; the next `welcome` leaves it out, so the desktop stops it.
      state.tokens.delete(message.runId);
      close(state, policyViolation("run_limit"));
      return;
    default: {
      stored satisfies never;
      panic("Unknown desktop runner persistence outcome");
    }
  }
};

/** Renew the runner and its leases, and refresh tokens about to expire. */
const renew = async (state: SessionState) => {
  // A revoked, expired or unlinked credential ends the socket before anything
  // else is renewed or minted for it.
  if (!(await state.context.isKeyLive(state.binding))) {
    close(state, DESKTOP_RUNNER_CLOSE.credentialRevoked);
    return;
  }
  if (!(await state.context.isRunnerEnabled(state.binding))) {
    close(state, DESKTOP_RUNNER_CLOSE.featureDisabled);
    return;
  }
  const now = state.context.now();
  const renewed = await renewRunnerSession(state.context.db, {
    binding: state.binding,
    sessionId: state.sessionId,
    now,
    leaseMs: state.context.timing.leaseMs,
  });
  if (renewed.type === "superseded") {
    close(state, DESKTOP_RUNNER_CLOSE.superseded);
    return;
  }
  for (const [runId, tracked] of state.tokens) {
    // A run the API ended gets no new token, whatever this socket last sent.
    if (!renewed.open.has(runId)) {
      state.tokens.delete(runId);
      continue;
    }
    // A run started but not accepted yet keeps its token tracked, so a
    // heartbeat after its acceptance still refreshes it.
    if (
      renewed.running.has(runId) &&
      tracked.expiresAt - now.getTime() <
        state.context.timing.tokenRefreshMarginMs
    ) {
      await sendToken(state, runId, tracked.workspaceIds);
    }
  }
};

const heartbeat = (state: SessionState) => {
  if (state.phase.type !== "ready") {
    return;
  }
  if (!state.heard) {
    state.missedPings += 1;
    if (state.missedPings >= MAX_MISSED_PINGS) {
      close(state, DESKTOP_RUNNER_CLOSE.heartbeatTimeout);
    } else {
      state.phase.socket.ping();
    }
    return;
  }
  state.heard = false;
  state.missedPings = 0;
  state.phase.socket.ping();
  detached(
    async () => await step(state, "heartbeat", async () => await renew(state)),
    "desktop-runner.heartbeat",
  );
};

/** Read through a call, so a check after an await sees the current phase. */
const isReady = (state: SessionState) => state.phase.type === "ready";

const onHello = async (
  state: SessionState,
  hello: Extract<DesktopRunnerDesktopMessage, { type: "hello" }>,
  socket: ApiServerWebSocket,
) => {
  const { context } = state;
  const claim = await claimRunnerSession(context.db, {
    binding: state.binding,
    sessionId: state.sessionId,
    instanceId: context.instanceId,
    hello,
    now: context.now(),
    leaseMs: context.timing.leaseMs,
    limits: context.limits,
  });
  if (claim.type === "too_many_runners") {
    close(state, DESKTOP_RUNNER_CLOSE.tooManyRunners);
    return;
  }
  // A newer key of the account replaced this one on the installation; the
  // desktop holding it stops rather than take the installation back.
  if (claim.type === "retired") {
    close(state, DESKTOP_RUNNER_CLOSE.superseded);
    return;
  }
  // Claimed, so the closing socket's release marks the runner disconnected.
  state.claimed = true;
  // The claim cleared what ran in the background before this socket; the
  // computer reports what still runs after `welcome`.
  if (claim.clearedBackgroundTasks) {
    context.announceBackgroundTasks(state.binding);
  }
  if (claim.previous !== null) {
    context.ringPrevious(claim.previous);
  }
  // A socket still open under a key this claim retired reads its queue at
  // once, finds itself retired and closes, instead of at its next heartbeat.
  for (const retired of claim.retired) {
    context.ringPrevious(retired);
  }
  // The socket may have closed while the claim was stored: then nothing is
  // scheduled or minted for it.
  if (state.phase.type === "closed") {
    return;
  }
  state.phase = {
    type: "ready",
    socket,
    held: new Set(claim.held.map(({ runId }) => runId)),
  };
  send(state, {
    type: DESKTOP_RUNNER_SERVER_MESSAGE.welcome,
    protocol: hello.protocol,
    resume: claim.held.map(({ runId, ackSeq }) => ({ runId, ackSeq })),
  });
  state.intervals.push(
    context.timers.setInterval(
      () => heartbeat(state),
      context.timing.pingIntervalMs,
    ),
  );
  const life =
    context.timing.maxSocketLifeMs * (1 - MAX_LIFE_JITTER * context.random());
  state.timeouts.push(
    context.timers.setTimeout(() => {
      drain(state, Math.floor(context.random() * MAX_LIFE_RECONNECT_SPREAD_MS));
    }, life),
  );
  for (const run of claim.held) {
    // Minting awaits, and the socket may close in between.
    if (!isReady(state)) {
      return;
    }
    if (run.state === "running") {
      await sendToken(state, run.runId, run.workspaceIds);
    }
  }
  await deliverPending(state, { resendSent: true });
};

/** Store a run's background count and tell the member's clients. */
const storeBackgroundTasks = async (
  state: SessionState,
  message: Extract<DesktopRunnerDesktopMessage, { type: "run.background" }>,
) => {
  const { binding, context } = state;
  const recorded = await recordBackgroundTasks(context.db, {
    binding,
    sessionId: state.sessionId,
    runId: message.runId,
    count: message.count,
  });
  switch (recorded) {
    case "applied":
      context.announceBackgroundTasks(binding);
      return;
    case "not_current":
      close(state, DESKTOP_RUNNER_CLOSE.superseded);
      return;
    case "unknown_run":
      // A run the API already forgot, or never routed here: its chat shows
      // nothing for it.
      return;
    case "too_many":
      close(state, policyViolation("run_limit"));
      return;
    default:
      recorded satisfies never;
      panic("Unhandled background count outcome");
  }
};

const handleMessage = async (
  state: SessionState,
  message: DesktopRunnerDesktopMessage,
) => {
  if (state.phase.type === "awaiting_hello") {
    if (message.type !== DESKTOP_RUNNER_DESKTOP_MESSAGE.hello) {
      close(state, policyViolation("hello_required"));
      return;
    }
    await onHello(state, message, state.phase.socket);
    return;
  }
  const { db, now, timing } = state.context;
  const { binding } = state;
  switch (message.type) {
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.hello:
      close(state, policyViolation("hello_repeated"));
      return;
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.harnessStatus: {
      const current = await recordHarnessStatus(db, {
        binding,
        sessionId: state.sessionId,
        report: message.harness,
      });
      if (!current) {
        close(state, DESKTOP_RUNNER_CLOSE.superseded);
      }
      return;
    }
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.linkedFoldersStatus: {
      const current = await recordLinkedFolders(db, {
        binding,
        sessionId: state.sessionId,
        folders: message.folders,
      });
      if (!current) {
        close(state, DESKTOP_RUNNER_CLOSE.superseded);
      }
      return;
    }
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runAccepted:
      closeForTransition(
        state,
        await recordRunAccepted(db, {
          binding,
          runId: message.runId,
          now: now(),
          leaseMs: timing.leaseMs,
        }),
      );
      return;
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runRejected: {
      const rejected = await recordRunRejected(db, {
        binding,
        runId: message.runId,
        reason: message.reason,
        now: now(),
      });
      if (rejected.type === "applied") {
        state.tokens.delete(message.runId);
        state.context.ringRun(message.runId);
      }
      closeForTransition(state, rejected);
      return;
    }
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent:
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest:
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished:
      await storeSequenced(state, message);
      return;
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.folderRestored:
      // An answer to a restore this computer was not sent, or answered
      // before, changes nothing: the restore stays as its first answer left it.
      await settleFolderRestore(db, {
        binding,
        restoreId: message.restoreId,
        outcome: message.outcome,
        now: now(),
      });
      return;
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runBackground:
      await storeBackgroundTasks(state, message);
      return;
    default: {
      message satisfies never;
      panic("Unknown desktop runner message");
    }
  }
};

const handleFrame = async (state: SessionState, frame: string) => {
  if (state.phase.type !== "awaiting_hello" && state.phase.type !== "ready") {
    return;
  }
  const parsed = parseDesktopRunnerFrame(frame);
  switch (parsed.type) {
    case "message":
      await handleMessage(state, parsed.message);
      return;
    case "unsupported_protocol":
      if (state.phase.type === "ready") {
        close(state, policyViolation("hello_repeated"));
        return;
      }
      send(state, {
        type: DESKTOP_RUNNER_SERVER_MESSAGE.upgradeRequired,
        minimumProtocol: DESKTOP_RUNNER_PROTOCOL.minimum,
        currentProtocol: DESKTOP_RUNNER_PROTOCOL.current,
      });
      close(state, DESKTOP_RUNNER_CLOSE.upgradeRequired);
      return;
    case "rejected":
      close(
        state,
        parsed.reason === DESKTOP_RUNNER_FRAME_REJECTION.tooLarge
          ? DESKTOP_RUNNER_CLOSE.tooLarge
          : policyViolation(parsed.reason),
      );
      return;
    default: {
      parsed satisfies never;
      panic("Unknown desktop runner frame");
    }
  }
};

/** Stop the socket's timers and record, after the step in flight, that it closed. */
const onSocketClosed = (state: SessionState) => {
  state.phase = { type: "closed" };
  for (const timeout of state.timeouts) {
    state.context.timers.clearTimeout(timeout);
  }
  for (const interval of state.intervals) {
    state.context.timers.clearInterval(interval);
  }
  const previous = state.chain;
  detached(async () => {
    await previous;
    if (!state.claimed) {
      return;
    }
    const released = await Result.tryPromise(
      async () =>
        await releaseRunnerSession(state.context.db, {
          binding: state.binding,
          sessionId: state.sessionId,
        }),
    );
    if (released.isErr()) {
      // Routing ignores the runner once its heartbeat goes stale.
      observeFailure(released.error, { sink: RELEASE_SINK });
    }
    // An open chat stops showing what this computer runs while it is away.
    state.context.announceBackgroundTasks(state.binding);
  }, "desktop-runner.release");
};

export type RunnerSession = {
  readonly sessionId: string;
  readonly socketSession: ApiSocketSession;
  /** Read this socket's queue now; resolves once what was read is sent. */
  readonly deliver: () => Promise<void>;
  /** The newest queued command this socket has sent. */
  readonly deliveredThrough: () => number;
  /** Ask the desktop to reconnect after `afterMs` and close. */
  readonly drain: (afterMs: number) => void;
};

/**
 * One desktop's runner socket: `hello` negotiation, the run messages it
 * sends, the commands queued for it and its heartbeat. An `ack` is sent only
 * after its message is stored.
 */
export const createRunnerSession = ({
  context,
  binding,
  sessionId,
  onClosed,
}: RunnerSessionOptions): RunnerSession => {
  const state: SessionState = {
    context,
    binding,
    sessionId,
    phase: { type: "connecting" },
    chain: Promise.resolve(),
    queuedFrames: 0,
    queuedBytes: 0,
    backpressured: false,
    drainOnOpen: null,
    queuedDelivery: null,
    deliveredThrough: 0,
    claimed: false,
    heard: true,
    missedPings: 0,
    tokens: new Map(),
    timeouts: [],
    intervals: [],
  };
  const socketSession: ApiSocketSession = {
    open: (socket) => {
      state.phase = { type: "awaiting_hello", socket };
      if (state.drainOnOpen !== null) {
        drain(state, state.drainOnOpen);
        return;
      }
      state.timeouts.push(
        context.timers.setTimeout(() => {
          if (state.phase.type === "awaiting_hello") {
            close(state, DESKTOP_RUNNER_CLOSE.helloTimeout);
          }
        }, context.timing.helloTimeoutMs),
      );
    },
    message: (_socket, message) => {
      state.heard = true;
      if (typeof message !== "string") {
        close(state, DESKTOP_RUNNER_CLOSE.unsupportedData);
        return;
      }
      // Frames wait in memory until the one before them is stored, so their
      // count and their bytes are both bounded.
      const bytes = Buffer.byteLength(message);
      if (
        state.queuedFrames >= MAX_QUEUED_FRAMES ||
        state.queuedBytes + bytes > context.limits.maxQueuedBytesPerSocket
      ) {
        close(state, DESKTOP_RUNNER_CLOSE.overloaded);
        return;
      }
      state.queuedFrames += 1;
      state.queuedBytes += bytes;
      detached(
        async () =>
          await step(state, "frame", async () => {
            state.queuedFrames -= 1;
            state.queuedBytes -= bytes;
            await handleFrame(state, message);
          }),
        "desktop-runner.frame",
      );
    },
    pong: () => {
      state.heard = true;
    },
    drain: () => {
      state.backpressured = false;
      detached(async () => await deliver(state), "desktop-runner.drain");
    },
    close: () => {
      onSocketClosed(state);
      onClosed(sessionId);
    },
  };
  return {
    sessionId,
    socketSession,
    deliver: async () => await deliver(state),
    deliveredThrough: () => state.deliveredThrough,
    drain: (afterMs) => drain(state, afterMs),
  };
};
