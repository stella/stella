import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  DESKTOP_RUNNER_FRAME_REJECTION,
  DESKTOP_RUNNER_PROTOCOL,
  DESKTOP_RUNNER_SERVER_MESSAGE,
  type DesktopRunnerDesktopMessage,
  type DesktopRunnerLimits,
  type DesktopRunnerServerMessage,
  desktopRunnerServerMessageSchema,
  parseDesktopRunnerFrame,
} from "@stll/api-contract/desktop-runner";

import type {
  ApiServerWebSocket,
  ApiSocketSession,
} from "@/api/http/websocket";
import { detached } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { isFoldableChunk } from "@/api/lib/desktop-runner/chunk";
import {
  DESKTOP_RUNNER_CLOSE,
  type DesktopRunnerClose,
  type DesktopRunnerTiming,
  policyViolation,
} from "@/api/lib/desktop-runner/protocol";
import {
  claimRunnerSession,
  type DesktopRunnerDb,
  type PendingCommand,
  persistRunMessage,
  readPendingCommands,
  recordHarnessStatus,
  recordRunAccepted,
  recordRunRejected,
  releaseRunnerSession,
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

/** What every socket of one gateway shares. */
type RunnerSessionContext = {
  readonly db: DesktopRunnerDb;
  readonly instanceId: string;
  readonly timing: DesktopRunnerTiming;
  readonly limits: DesktopRunnerLimits;
  readonly now: () => Date;
  readonly random: () => number;
  readonly mintRunToken: MintRunToken;
  /** Tell the socket a newer one replaced that it is no longer current. */
  readonly ringPrevious: (holder: RunHolder) => void;
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
  queuedDelivery: Promise<void> | null;
  /** The last queued command this socket has sent. */
  deliveredThrough: number;
  /** Whether `hello` made this socket the desktop's current one. */
  claimed: boolean;
  heard: boolean;
  missedPings: number;
  /** Tokens this socket sent, refreshed before they expire. */
  readonly tokens: Map<string, TrackedToken>;
  readonly timeouts: ReturnType<typeof setTimeout>[];
  readonly intervals: ReturnType<typeof setInterval>[];
};

const runStartPayloadSchema = v.looseObject({
  mcp: v.looseObject({}),
});

const close = (state: SessionState, reason: DesktopRunnerClose) => {
  if (state.phase.type === "closed" || state.phase.type === "connecting") {
    return;
  }
  const { socket } = state.phase;
  state.phase = { type: "closed" };
  socket.close(reason.code, reason.reason);
};

const send = (
  state: SessionState,
  message: DesktopRunnerServerMessage,
): boolean => {
  if (state.phase.type !== "awaiting_hello" && state.phase.type !== "ready") {
    return false;
  }
  // 0 means Bun dropped the frame; the queue is replayed on the next socket.
  if (state.phase.socket.send(JSON.stringify(message)) === 0) {
    close(state, DESKTOP_RUNNER_CLOSE.internalError);
    return false;
  }
  return true;
};

const drain = (state: SessionState, afterMs: number) => {
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

/** A stored command as the message to send, with a fresh token for `run.start`. */
const compose = async (
  state: SessionState,
  command: PendingCommand,
): Promise<DesktopRunnerServerMessage> => {
  let candidate = command.payload;
  if (command.kind === DESKTOP_RUNNER_SERVER_MESSAGE.runStart) {
    const stored = v.parse(runStartPayloadSchema, command.payload);
    const token = await mint(state, command.runId, command.workspaceIds);
    candidate = { ...stored, mcp: { ...stored.mcp, ...token } };
  }
  const message = v.safeParse(desktopRunnerServerMessageSchema, candidate);
  // Commands are validated when queued; one that no longer is was corrupted.
  return message.success
    ? message.output
    : panic(`A queued ${command.kind} no longer validates`);
};

/** Send every command queued after the last one sent, page by page. */
const deliverPending = async (state: SessionState) => {
  if (state.phase.type !== "ready") {
    return;
  }
  const { held } = state.phase;
  for (;;) {
    // db-await-in-loop: keyset page per iteration; the page is the batch
    const pending = await readPendingCommands(state.context.db, {
      binding: state.binding,
      sessionId: state.sessionId,
      afterId: state.deliveredThrough,
      limit: COMMAND_PAGE_SIZE,
    });
    if (pending.type === "superseded") {
      close(state, DESKTOP_RUNNER_CLOSE.superseded);
      return;
    }
    for (const command of pending.commands) {
      const resend =
        command.kind !== DESKTOP_RUNNER_SERVER_MESSAGE.runStart ||
        !held.has(command.runId);
      if (resend && !send(state, await compose(state, command))) {
        return;
      }
      state.deliveredThrough = command.id;
    }
    if (pending.commands.length < COMMAND_PAGE_SIZE) {
      return;
    }
  }
};

const deliver = async (state: SessionState) => {
  // One queued delivery reads everything queued before it runs.
  state.queuedDelivery ??= step(state, "deliver", async () => {
    state.queuedDelivery = null;
    await deliverPending(state);
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
  });
  switch (stored.type) {
    case "persisted":
      if (message.type === DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished) {
        state.tokens.delete(message.runId);
      }
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
    default: {
      stored satisfies never;
      panic("Unknown desktop runner persistence outcome");
    }
  }
};

/** Renew the runner and its leases, and refresh tokens about to expire. */
const renew = async (state: SessionState) => {
  const now = state.context.now();
  const current = await renewRunnerSession(state.context.db, {
    binding: state.binding,
    sessionId: state.sessionId,
    now,
    leaseMs: state.context.timing.leaseMs,
  });
  if (!current) {
    close(state, DESKTOP_RUNNER_CLOSE.superseded);
    return;
  }
  for (const [runId, tracked] of state.tokens) {
    if (
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
    step(state, "heartbeat", async () => await renew(state)),
    "desktop-runner.heartbeat",
  );
};

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
  state.claimed = true;
  if (claim.previous !== null) {
    context.ringPrevious(claim.previous);
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
    setInterval(() => heartbeat(state), context.timing.pingIntervalMs),
  );
  const life =
    context.timing.maxSocketLifeMs * (1 - MAX_LIFE_JITTER * context.random());
  state.timeouts.push(
    setTimeout(() => {
      drain(state, Math.floor(context.random() * MAX_LIFE_RECONNECT_SPREAD_MS));
    }, life),
  );
  for (const run of claim.held) {
    if (run.state === "running") {
      await sendToken(state, run.runId, run.workspaceIds);
    }
  }
  await deliverPending(state);
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
      }
      closeForTransition(state, rejected);
      return;
    }
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent:
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest:
    case DESKTOP_RUNNER_DESKTOP_MESSAGE.runFinished:
      await storeSequenced(state, message);
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
    clearTimeout(timeout);
  }
  for (const interval of state.intervals) {
    clearInterval(interval);
  }
  const previous = state.chain;
  detached(
    (async () => {
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
    })(),
    "desktop-runner.release",
  );
};

export type RunnerSession = {
  readonly sessionId: string;
  readonly socketSession: ApiSocketSession;
  /** Read this socket's queue now; resolves once what was read is sent. */
  readonly deliver: () => Promise<void>;
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
      state.timeouts.push(
        setTimeout(() => {
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
      if (state.queuedFrames >= MAX_QUEUED_FRAMES) {
        close(state, DESKTOP_RUNNER_CLOSE.overloaded);
        return;
      }
      state.queuedFrames += 1;
      detached(
        step(state, "frame", async () => {
          state.queuedFrames -= 1;
          await handleFrame(state, message);
        }),
        "desktop-runner.frame",
      );
    },
    pong: () => {
      state.heard = true;
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
    drain: (afterMs) => drain(state, afterMs),
  };
};
