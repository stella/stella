import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { AgentHarness } from "@stll/api-contract/agent-harness";
import {
  DESKTOP_RUNNER_HARNESS_STATE,
  DESKTOP_RUNNER_LIMITS,
  DESKTOP_RUNNER_MAX_FRAME_BYTES,
  DESKTOP_RUNNER_MAX_TOKEN_LENGTH,
  DESKTOP_RUNNER_SERVER_MESSAGE,
  type DesktopRunnerHarnessReport,
  type DesktopRunnerLimits,
  type DesktopRunnerServerMessage,
  desktopRunnerServerMessageSchema,
} from "@stll/api-contract/desktop-runner";

import type { SafeId } from "@/api/lib/branded-types";
import type { DesktopRunnerDoorbell } from "@/api/lib/desktop-runner/doorbell";
import {
  DESKTOP_RUNNER_TIMING,
  type DesktopRunnerTiming,
} from "@/api/lib/desktop-runner/protocol";
import {
  type DesktopRunnerDb,
  type DesktopRunnerRunView,
  insertAssignedRun,
  type InsertedCommand,
  insertRunCommand,
  readConnectedRunners,
  readRun,
  readStoredRunEvents,
  type RunOwner,
  type StoredRunEvent,
} from "@/api/lib/desktop-runner/store";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";

type ReadyHarnessReport = Extract<
  DesktopRunnerHarnessReport,
  { state: typeof DESKTOP_RUNNER_HARNESS_STATE.ready }
>;

/** A command whose fields the wire contract refuses. */
class DesktopRunnerCommandInvalid extends TaggedError(
  "DesktopRunnerCommandInvalid",
)<{ message: string; kind: DesktopRunnerServerMessage["type"] }> {}

export type DesktopRunnerControlError =
  DesktopRunnerCommandInvalid | DatabaseError;

type RunStart = Extract<
  DesktopRunnerServerMessage,
  { type: typeof DESKTOP_RUNNER_SERVER_MESSAGE.runStart }
>;
type RunInput = Extract<
  DesktopRunnerServerMessage,
  { type: typeof DESKTOP_RUNNER_SERVER_MESSAGE.runInput }
>;
type RunApproval = Extract<
  DesktopRunnerServerMessage,
  { type: typeof DESKTOP_RUNNER_SERVER_MESSAGE.runApproval }
>;

/** Which of a member's computers can take a run of `harness`. */
export type PickedDesktop =
  | { type: "available"; desktopId: string; harness: ReadyHarnessReport }
  /** No computer of the member has an open runner socket. */
  | { type: "no_computer" }
  /** The most recently seen computer cannot run the harness now. */
  | {
      type: "harness_unavailable";
      desktopId: string;
      report: DesktopRunnerHarnessReport | null;
    };

export type StartLocalRunInput = {
  owner: RunOwner;
  runId: string;
  desktopId: string;
  harness: AgentHarness;
  harnessVersion: string;
  model: string;
  harnessSessionId: string | null;
  instructions: string;
  messages: RunStart["messages"];
  /** Where the run reaches the workspace; its token is minted on every send. */
  mcp: Omit<RunStart["mcp"], "token" | "expiresAt">;
  /** Workspaces already authorized for this member and run. */
  workspaceIds: readonly SafeId<"workspace">[];
};

export type StartLocalRunOutcome =
  | { type: "assigned" }
  | { type: "duplicate" }
  /** The run id is already bound to another computer or member. */
  | { type: "conflict" }
  | { type: "no_computer" }
  | {
      type: "harness_unavailable";
      report: DesktopRunnerHarnessReport | null;
    }
  | { type: "model_unavailable" }
  /** The message would not fit one frame, even with the longest token. */
  | { type: "too_large" };

export type QueueCommandOutcome =
  | { type: "queued" }
  | Exclude<InsertedCommand, { type: "queued" }>
  /** The message would not fit one frame. */
  | { type: "too_large" };

export type DesktopRunnerEventPage = {
  readonly items: readonly StoredRunEvent[];
  /** Pass as `afterSeq` for the next page; `null` when this page was the last. */
  readonly nextAfterSeq: number | null;
};

/**
 * The longest token a send may mint, standing in for it: a message checked
 * with it fits a frame with any token.
 */
const TOKEN_SHAPE = "t".repeat(DESKTOP_RUNNER_MAX_TOKEN_LENGTH);

/** Whether `message`, as sent, fits one frame. */
const fitsOneFrame = (message: unknown) =>
  Buffer.byteLength(JSON.stringify(message)) <= DESKTOP_RUNNER_MAX_FRAME_BYTES;
const MAX_EVENT_PAGE = 500;
const MAX_CANDIDATE_RUNNERS = 10;

type ControlOptions = {
  db: DesktopRunnerDb;
  doorbell: DesktopRunnerDoorbell;
  now?: () => Date;
  timing?: Partial<DesktopRunnerTiming>;
  limits?: Partial<DesktopRunnerLimits>;
};

/** What every control operation reads from. */
type ControlDeps = {
  readonly db: DesktopRunnerDb;
  readonly doorbell: DesktopRunnerDoorbell;
  readonly now: () => Date;
  readonly timing: DesktopRunnerTiming;
  readonly limits: DesktopRunnerLimits;
};

const toDatabaseError = (cause: unknown) =>
  new DatabaseError({ message: "Desktop runner store is unavailable", cause });

const invalid = (
  kind: DesktopRunnerServerMessage["type"],
  issues: v.BaseIssue<unknown>[],
) =>
  new DesktopRunnerCommandInvalid({
    kind,
    message: `${kind} is invalid: ${issues.map(({ message }) => message).join("; ")}`,
  });

/** Runners seen this recently may take a run. */
const seenSince = ({ now, timing }: ControlDeps) =>
  new Date(now().getTime() - timing.runnerFreshnessMs);

type PickDesktopOptions = { owner: RunOwner; harness: AgentHarness };

const pickDesktop = async (
  deps: ControlDeps,
  { owner, harness }: PickDesktopOptions,
): Promise<Result<PickedDesktop, DatabaseError>> => {
  const runners = await Result.tryPromise({
    try: async () =>
      await readConnectedRunners(deps.db, {
        ...owner,
        seenSince: seenSince(deps),
        limit: MAX_CANDIDATE_RUNNERS,
      }),
    catch: toDatabaseError,
  });
  if (runners.isErr()) {
    return runners;
  }
  for (const runner of runners.value) {
    const report = runner.harnesses.find(({ id }) => id === harness);
    // Only what the computer reports `ready` is routed to.
    if (report?.state === DESKTOP_RUNNER_HARNESS_STATE.ready) {
      return Result.ok({
        type: "available",
        desktopId: runner.desktopId,
        harness: report,
      });
    }
  }
  const latest = runners.value.at(0);
  return Result.ok(
    latest === undefined
      ? { type: "no_computer" }
      : {
          type: "harness_unavailable",
          desktopId: latest.desktopId,
          report: latest.harnesses.find(({ id }) => id === harness) ?? null,
        },
  );
};

const startRun = async (
  deps: ControlDeps,
  input: StartLocalRunInput,
): Promise<Result<StartLocalRunOutcome, DesktopRunnerControlError>> => {
  const message = {
    type: DESKTOP_RUNNER_SERVER_MESSAGE.runStart,
    runId: input.runId,
    harness: input.harness,
    harnessVersion: input.harnessVersion,
    model: input.model,
    harnessSessionId: input.harnessSessionId,
    instructions: input.instructions,
    messages: input.messages,
    policy: { network: "open", fs: "workspace" },
    mcp: input.mcp,
  } as const;
  const checked = v.safeParse(desktopRunnerServerMessageSchema, {
    ...message,
    mcp: {
      ...message.mcp,
      token: TOKEN_SHAPE,
      expiresAt: deps.now().toISOString(),
    },
  });
  if (!checked.success) {
    return Result.err(invalid(message.type, checked.issues));
  }
  if (!fitsOneFrame(checked.output)) {
    return Result.ok({ type: "too_large" });
  }
  const inserted = await Result.tryPromise({
    try: async () =>
      await insertAssignedRun(deps.db, {
        owner: input.owner,
        runId: input.runId,
        desktopId: input.desktopId,
        harness: input.harness,
        harnessVersion: input.harnessVersion,
        model: input.model,
        workspaceIds: input.workspaceIds,
        payload: message,
        now: deps.now(),
        leaseMs: deps.timing.leaseMs,
        seenSince: seenSince(deps),
      }),
    catch: toDatabaseError,
  });
  if (inserted.isErr()) {
    return inserted;
  }
  const outcome = inserted.value;
  if (outcome.type === "assigned") {
    deps.doorbell.ring(outcome.holder);
    return Result.ok({ type: "assigned" });
  }
  return Result.ok(outcome);
};

/** A queued command other than `run.start`, which `startRun` queues. */
type QueuedMessage = Extract<
  DesktopRunnerServerMessage,
  {
    type:
      | typeof DESKTOP_RUNNER_SERVER_MESSAGE.runInput
      | typeof DESKTOP_RUNNER_SERVER_MESSAGE.runApproval
      | typeof DESKTOP_RUNNER_SERVER_MESSAGE.runInterrupt
      | typeof DESKTOP_RUNNER_SERVER_MESSAGE.runCancel;
  }
>;

/** The id a command is idempotent on, and the approval request it answers. */
const commandKeyOf = (message: QueuedMessage) => {
  switch (message.type) {
    case DESKTOP_RUNNER_SERVER_MESSAGE.runInput:
      return { commandKey: message.inputId, answersRequestId: null };
    case DESKTOP_RUNNER_SERVER_MESSAGE.runApproval:
      return {
        commandKey: message.requestId,
        answersRequestId: message.requestId,
      };
    case DESKTOP_RUNNER_SERVER_MESSAGE.runInterrupt:
    case DESKTOP_RUNNER_SERVER_MESSAGE.runCancel:
      return { commandKey: message.runId, answersRequestId: null };
    default: {
      message satisfies never;
      return panic("Unknown desktop runner command");
    }
  }
};

const queue = async (
  deps: ControlDeps,
  owner: RunOwner,
  message: QueuedMessage,
): Promise<Result<QueueCommandOutcome, DesktopRunnerControlError>> => {
  const checked = v.safeParse(desktopRunnerServerMessageSchema, message);
  if (!checked.success) {
    return Result.err(invalid(message.type, checked.issues));
  }
  if (!fitsOneFrame(checked.output)) {
    return Result.ok({ type: "too_large" });
  }
  const inserted = await Result.tryPromise({
    try: async () =>
      await insertRunCommand(deps.db, {
        owner,
        runId: message.runId,
        kind: message.type,
        payload: checked.output,
        limits: deps.limits,
        ...commandKeyOf(message),
      }),
    catch: toDatabaseError,
  });
  if (inserted.isErr()) {
    return inserted;
  }
  const outcome = inserted.value;
  if (outcome.type !== "queued") {
    return Result.ok(outcome);
  }
  // A desktop that is away receives the command when it reconnects.
  if (outcome.holder !== null) {
    deps.doorbell.ring(outcome.holder);
  }
  return Result.ok({ type: "queued" });
};

type RunOptions = { owner: RunOwner; runId: string };
type ReadEventsOptions = RunOptions & { afterSeq: number; limit: number };

const readEvents = async (
  deps: ControlDeps,
  { owner, runId, afterSeq, limit }: ReadEventsOptions,
): Promise<Result<DesktopRunnerEventPage, DatabaseError>> => {
  const bounded = Math.min(Math.max(1, Math.floor(limit)), MAX_EVENT_PAGE);
  const items = await Result.tryPromise({
    try: async () =>
      await readStoredRunEvents(deps.db, {
        owner,
        runId,
        afterSeq,
        limit: bounded,
      }),
    catch: toDatabaseError,
  });
  if (items.isErr()) {
    return items;
  }
  return Result.ok({
    items: items.value,
    nextAfterSeq:
      items.value.length < bounded ? null : (items.value.at(-1)?.seq ?? null),
  });
};

/**
 * What the rest of the API uses to run work on a member's computer: pick a
 * computer, queue commands for a run, read what the run produced. Commands are
 * stored before the doorbell rings, so a lost ring only delays them.
 */
export const createDesktopRunnerControl = ({
  db,
  doorbell,
  now = () => new Date(),
  timing,
  limits,
}: ControlOptions) => {
  const deps: ControlDeps = {
    db,
    doorbell,
    now,
    timing: { ...DESKTOP_RUNNER_TIMING, ...timing },
    limits: { ...DESKTOP_RUNNER_LIMITS, ...limits },
  };
  return {
    pickDesktop: async (options: PickDesktopOptions) =>
      await pickDesktop(deps, options),
    startRun: async (input: StartLocalRunInput) => await startRun(deps, input),
    /** Add a user message to a running run; idempotent on `inputId`. */
    sendInput: async ({
      owner,
      runId,
      inputId,
      message,
    }: RunOptions & { inputId: string; message: RunInput["message"] }) =>
      await queue(deps, owner, {
        type: DESKTOP_RUNNER_SERVER_MESSAGE.runInput,
        runId,
        inputId,
        message,
      }),
    /** Answer an approval the run requested; idempotent on `requestId`. */
    answerApproval: async ({
      owner,
      runId,
      requestId,
      decision,
    }: RunOptions & {
      requestId: string;
      decision: RunApproval["decision"];
    }) =>
      await queue(deps, owner, {
        type: DESKTOP_RUNNER_SERVER_MESSAGE.runApproval,
        runId,
        requestId,
        decision,
      }),
    /** Stop the current turn; the run stays open. */
    interruptRun: async ({ owner, runId }: RunOptions) =>
      await queue(deps, owner, {
        type: DESKTOP_RUNNER_SERVER_MESSAGE.runInterrupt,
        runId,
      }),
    /** End the run; a computer that is away receives it when it reconnects. */
    cancelRun: async ({ owner, runId }: RunOptions) =>
      await queue(deps, owner, {
        type: DESKTOP_RUNNER_SERVER_MESSAGE.runCancel,
        runId,
      }),
    readRun: async ({
      owner,
      runId,
    }: RunOptions): Promise<
      Result<DesktopRunnerRunView | null, DatabaseError>
    > =>
      await Result.tryPromise({
        try: async () => await readRun(db, { owner, runId }),
        catch: toDatabaseError,
      }),
    /** The run's stored messages after `afterSeq`, in sequence order. */
    readEvents: async (options: ReadEventsOptions) =>
      await readEvents(deps, options),
  };
};

export type DesktopRunnerControl = ReturnType<
  typeof createDesktopRunnerControl
>;
