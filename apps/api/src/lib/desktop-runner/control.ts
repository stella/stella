import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import type { AgentHarness } from "@stll/api-contract/agent-harness";
import type { ChatLocalRunSteerOutcome } from "@stll/api-contract/chat-run-target";
import {
  DESKTOP_RUNNER_ATTACHMENT_LINK_MAX_LENGTH,
  DESKTOP_RUNNER_DESKTOP_MESSAGE,
  DESKTOP_RUNNER_HARNESS_STATE,
  DESKTOP_RUNNER_LIMITS,
  DESKTOP_RUNNER_MAX_FRAME_BYTES,
  DESKTOP_RUNNER_MAX_TOKEN_LENGTH,
  DESKTOP_RUNNER_SERVER_MESSAGE,
  DESKTOP_RUNNER_TIMING,
  type DesktopRunnerApprovalMode,
  type DesktopRunnerHarnessReport,
  type DesktopRunnerLimits,
  type DesktopRunnerReasoningEffort,
  type DesktopRunnerServerMessage,
  desktopRunnerServerMessageSchema,
  type DesktopRunnerTiming,
} from "@stll/api-contract/desktop-runner";

import type { SafeId } from "@/api/lib/branded-types";
import { pairAppCall, recordAppCall } from "@/api/lib/desktop-runner/app-calls";
import type { DesktopRunnerDoorbell } from "@/api/lib/desktop-runner/doorbell";
import {
  type FolderRestoreView,
  readTurnFolderRestore,
  type RequestedFolderRestore,
  requestFolderRestore,
  type TurnFolderRestore,
} from "@/api/lib/desktop-runner/folder-restores";
import {
  type RunAnswerMessage,
  sealRunAnswer,
} from "@/api/lib/desktop-runner/sealed-answers";
import {
  type AnsweredRequest,
  type ChatRunBinding,
  type ChatRunForRequest,
  type DesktopRunnerDb,
  type DesktopRunnerRunView,
  insertAssignedRun,
  type InsertedCommand,
  insertRunCommand,
  type MemberRunner,
  readChatRunForRequest,
  readChatRunSession,
  readConnectedRunners,
  readMemberRunners,
  readOpenRunChatThread,
  readRun,
  readRunInputText,
  readRunOutputFile,
  readSteerableChatRun,
  readStoredRunEvents,
  recordChatReadSeq,
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

/** A file a run copies: where it lands and which stored file it is. */
export type LocalRunAttachment = {
  path: string;
  fileId: string;
  fileName: string;
  s3Key: string;
};

export type StartLocalRunInput = {
  owner: RunOwner;
  desktopId: string;
  harness: AgentHarness;
  harnessVersion: string;
  model: string;
  /** The effort the run asks the model for; the computer must report it. */
  reasoningEffort: DesktopRunnerReasoningEffort | null;
  /** How much the run asks before it acts; the computer must report it. */
  approvals: DesktopRunnerApprovalMode;
  harnessSessionId: string | null;
  instructions: string;
  messages: RunStart["messages"];
  /** Files to copy into the run's folder; each link is signed on every send. */
  attachments: readonly LocalRunAttachment[];
  /** Where the run reaches the workspace; its token is minted on every send. */
  mcp: Omit<RunStart["mcp"], "token" | "expiresAt">;
  /** Workspaces already authorized for this member and run. */
  workspaceIds: readonly SafeId<"workspace">[];
  /** The chat turn that starts and reads the run, when one does. */
  chat?: ChatRunBinding | null;
};

export type StartLocalRunOutcome =
  /** The run's id is minted here, so no caller-chosen id can name another's run. */
  | { type: "assigned"; runId: string }
  | { type: "no_computer" }
  | {
      type: "harness_unavailable";
      report: DesktopRunnerHarnessReport | null;
    }
  | { type: "model_unavailable" }
  | { type: "reasoning_effort_unavailable" }
  | { type: "approvals_unavailable" }
  /** The chat's folder is being restored on its computer. */
  | { type: "folder_busy" }
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
const ATTACHMENT_LINK_SHAPE = `https://${"l".repeat(
  DESKTOP_RUNNER_ATTACHMENT_LINK_MAX_LENGTH - "https://".length,
)}`;

/** Whether `message`, as sent, fits one frame. */
const fitsOneFrame = (message: unknown) =>
  Buffer.byteLength(JSON.stringify(message)) <= DESKTOP_RUNNER_MAX_FRAME_BYTES;
const MAX_EVENT_PAGE = 500;
const MAX_CANDIDATE_RUNNERS = 10;
/**
 * How long an undo waits for its computer's socket to take it. A computer that
 * is away is refused at once; this only covers a socket that drops in between,
 * so the files never change long after the member asked.
 */
const FOLDER_RESTORE_WAIT_MS = 2 * 60_000;

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

/**
 * What a run is told when its chat's folder was put back since the last run:
 * written by the server, so the harness knows its earlier edits are gone.
 */
export const FOLDER_RESTORED_NOTE =
  "Note from stella: the member undid the file changes of an earlier reply, so the working folder is as it was before that reply. Read files again before relying on what you saw or wrote earlier.";

/** The messages with the note added to the newest member message. */
const withRestoredNote = (
  messages: RunStart["messages"],
): RunStart["messages"] => {
  const note = { type: "text", content: FOLDER_RESTORED_NOTE };
  const last = messages.at(-1);
  if (last?.role !== "user") {
    return [...messages, { role: "user", content: [note] }];
  }
  const content: unknown = last["content"];
  let parts: readonly unknown[] = [];
  if (typeof content === "string") {
    parts = [{ type: "text", content }];
  } else if (Array.isArray(content)) {
    parts = content;
  }
  return [...messages.slice(0, -1), { ...last, content: [...parts, note] }];
};

const startRun = async (
  deps: ControlDeps,
  input: StartLocalRunInput,
): Promise<Result<StartLocalRunOutcome, DesktopRunnerControlError>> => {
  const chat = input.chat ?? null;
  const runId = Bun.randomUUIDv7();
  const message = {
    type: DESKTOP_RUNNER_SERVER_MESSAGE.runStart,
    runId,
    // A chat's turns share a folder; a run outside a chat keeps its own.
    folderId: input.chat?.threadId ?? runId,
    harness: input.harness,
    harnessVersion: input.harnessVersion,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    harnessSessionId: input.harnessSessionId,
    instructions: input.instructions,
    messages: input.messages,
    attachments: input.attachments.map(({ path, s3Key }) => ({ path, s3Key })),
    policy: { network: "open", fs: "workspace", approvals: input.approvals },
    mcp: input.mcp,
  } as const;
  // A chat's run tells about a restore of its folder when one is not told yet;
  // the admission picks which is stored. The noted one is the larger, so its
  // check covers both.
  const withNote =
    chat === null
      ? message
      : { ...message, messages: withRestoredNote(input.messages) };
  const checked = v.safeParse(desktopRunnerServerMessageSchema, {
    ...withNote,
    attachments: input.attachments.map(({ path }) => ({
      path,
      url: ATTACHMENT_LINK_SHAPE,
    })),
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
        runId,
        desktopId: input.desktopId,
        harness: input.harness,
        harnessVersion: input.harnessVersion,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
        approvals: input.approvals,
        workspaceIds: input.workspaceIds,
        chat,
        payload: { plain: message, withNote },
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
    return Result.ok({ type: "assigned", runId });
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
      | typeof DESKTOP_RUNNER_SERVER_MESSAGE.runAnswer
      | typeof DESKTOP_RUNNER_SERVER_MESSAGE.runInterrupt
      | typeof DESKTOP_RUNNER_SERVER_MESSAGE.runCancel;
  }
>;

/** The id a command is idempotent on, and the request it answers. */
const commandKeyOf = (
  message: QueuedMessage,
): { commandKey: string; answers: AnsweredRequest | null } => {
  switch (message.type) {
    case DESKTOP_RUNNER_SERVER_MESSAGE.runInput:
      return { commandKey: message.inputId, answers: null };
    case DESKTOP_RUNNER_SERVER_MESSAGE.runApproval:
      return {
        commandKey: message.requestId,
        answers: {
          requestId: message.requestId,
          askedBy: DESKTOP_RUNNER_DESKTOP_MESSAGE.runApprovalRequest,
        },
      };
    case DESKTOP_RUNNER_SERVER_MESSAGE.runAnswer:
      return {
        commandKey: message.requestId,
        answers: {
          requestId: message.requestId,
          askedBy: DESKTOP_RUNNER_DESKTOP_MESSAGE.runEvent,
        },
      };
    case DESKTOP_RUNNER_SERVER_MESSAGE.runInterrupt:
    case DESKTOP_RUNNER_SERVER_MESSAGE.runCancel:
      return { commandKey: message.runId, answers: null };
    default: {
      message satisfies never;
      return panic("Unknown desktop runner command");
    }
  }
};

/**
 * The command as the queue keeps it: as sent, except that answers to a
 * question are sealed (`sealed-answers.ts`).
 */
const storedPayloadOf = async (
  owner: RunOwner,
  message: QueuedMessage,
): Promise<object> => {
  switch (message.type) {
    case DESKTOP_RUNNER_SERVER_MESSAGE.runAnswer:
      return await sealRunAnswer(owner.organizationId, message);
    case DESKTOP_RUNNER_SERVER_MESSAGE.runInput:
    case DESKTOP_RUNNER_SERVER_MESSAGE.runApproval:
    case DESKTOP_RUNNER_SERVER_MESSAGE.runInterrupt:
    case DESKTOP_RUNNER_SERVER_MESSAGE.runCancel:
      return message;
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
  const payload = await Result.tryPromise({
    try: async () => await storedPayloadOf(owner, message),
    catch: (cause) =>
      new DatabaseError({
        message: "Desktop runner command could not be sealed",
        cause,
      }),
  });
  if (payload.isErr()) {
    return payload;
  }
  const inserted = await Result.tryPromise({
    try: async () =>
      await insertRunCommand(deps.db, {
        owner,
        runId: message.runId,
        kind: message.type,
        payload: payload.value,
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

type TurnRestoreOptions = {
  owner: RunOwner;
  threadId: SafeId<"chatThread">;
  turnId: SafeId<"chatTurn">;
};

export type RequestFolderRestoreOutcome =
  | { type: "accepted"; restore: FolderRestoreView }
  | Extract<RequestedFolderRestore, { type: "refused" }>;

/**
 * Ask the run's computer to put the chat's folder back as it was before the
 * turn; the restore id is minted here. A repeat answers the turn's restore
 * that is still going or done.
 */
const requestRestore = async (
  deps: ControlDeps,
  options: TurnRestoreOptions,
): Promise<Result<RequestFolderRestoreOutcome, DatabaseError>> => {
  const requested = await Result.tryPromise({
    try: async () =>
      await requestFolderRestore(deps.db, {
        ...options,
        restoreId: Bun.randomUUIDv7(),
        now: deps.now(),
        seenSince: seenSince(deps),
        expiresInMs: FOLDER_RESTORE_WAIT_MS,
      }),
    catch: toDatabaseError,
  });
  if (requested.isErr()) {
    return requested;
  }
  const outcome = requested.value;
  switch (outcome.type) {
    case "queued":
      deps.doorbell.ring(outcome.holder);
      return Result.ok({ type: "accepted", restore: outcome.restore });
    case "existing":
      return Result.ok({ type: "accepted", restore: outcome.restore });
    case "refused":
      return Result.ok(outcome);
    default: {
      outcome satisfies never;
      return panic("Unknown folder restore outcome");
    }
  }
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

type SteerChatTurnOptions = {
  owner: RunOwner;
  chat: ChatRunBinding;
  inputId: string;
  text: string;
};

const steerChatTurn = async (
  deps: ControlDeps,
  { owner, chat, inputId, text }: SteerChatTurnOptions,
): Promise<Result<ChatLocalRunSteerOutcome, DesktopRunnerControlError>> => {
  const run = await Result.tryPromise({
    try: async () => await readSteerableChatRun(deps.db, { owner, chat }),
    catch: toDatabaseError,
  });
  if (run.isErr()) {
    return run;
  }
  if (run.value === null || !run.value.steerable) {
    return Result.ok("unavailable");
  }
  const queued = await queue(deps, owner, {
    type: DESKTOP_RUNNER_SERVER_MESSAGE.runInput,
    runId: run.value.runId,
    inputId,
    message: { role: "user", content: text },
  });
  return queued.map((outcome) =>
    outcome.type === "queued" || outcome.type === "duplicate"
      ? "queued"
      : "unavailable",
  );
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
    /**
     * Steer chat turn `chat.turnId` with `text`: hand it to the turn's run
     * when its harness reports `steer`; idempotent on `inputId`. `queued`
     * means the computer will say on the run's stream whether it took it.
     */
    steerChatTurn: async (options: SteerChatTurnOptions) =>
      await steerChatTurn(deps, options),
    /** The text the owner's run was steered with under `inputId`. */
    readRunInputText: async (
      options: Parameters<typeof readRunInputText>[1],
    ): Promise<Result<string | null, DatabaseError>> =>
      await Result.tryPromise({
        try: async () => await readRunInputText(db, options),
        catch: toDatabaseError,
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
    /**
     * Answer a blocking question the run asked, keyed by question id;
     * idempotent on `requestId`. The answers are stored sealed.
     */
    answerQuestion: async ({
      owner,
      runId,
      requestId,
      answers,
    }: RunOptions & {
      requestId: string;
      answers: RunAnswerMessage["answers"];
    }) =>
      await queue(deps, owner, {
        type: DESKTOP_RUNNER_SERVER_MESSAGE.runAnswer,
        runId,
        requestId,
        answers,
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
    /** The chat thread of the owner's run that is still going. */
    readOpenRunChatThread: async (
      options: RunOptions,
    ): Promise<Result<SafeId<"chatThread"> | null, DatabaseError>> =>
      await Result.tryPromise({
        try: async () => await readOpenRunChatThread(db, options),
        catch: toDatabaseError,
      }),
    /** A file a run reported, if it is the owner's and in this thread. */
    readRunOutputFile: async (
      options: Parameters<typeof readRunOutputFile>[1],
    ) =>
      await Result.tryPromise({
        try: async () => await readRunOutputFile(db, options),
        catch: toDatabaseError,
      }),
    /** Record what the server answered the run for a tool an app presents. */
    recordAppCall: async (options: Parameters<typeof recordAppCall>[1]) =>
      await Result.tryPromise({
        try: async () => await recordAppCall(db, options),
        catch: toDatabaseError,
      }),
    /** The server's answer for a call the run reported, paired with it once. */
    pairAppCall: async (options: Parameters<typeof pairAppCall>[1]) =>
      await Result.tryPromise({
        try: async () => await pairAppCall(db, options),
        catch: toDatabaseError,
      }),
    /** The run's stored messages after `afterSeq`, in sequence order. */
    readEvents: async (options: ReadEventsOptions) =>
      await readEvents(deps, options),
    /**
     * The member's computers and what their harnesses last reported. A
     * computer counts as connected only while its socket is fresh, the same
     * rule `pickDesktop` routes by.
     */
    readMemberRunners: async ({
      owner,
    }: {
      owner: RunOwner;
    }): Promise<Result<MemberRunner[], DatabaseError>> => {
      const freshSince = seenSince(deps);
      const read = await Result.tryPromise({
        try: async () =>
          await readMemberRunners(db, {
            owner,
            limit: deps.limits.maxRunnersPerAccount,
          }),
        catch: toDatabaseError,
      });
      return read.map((items) =>
        items.map((item) => ({
          ...item,
          connected: item.connected && item.lastSeenAt >= freshSince,
        })),
      );
    },
    /** The harness session a thread's next turn on this computer resumes. */
    readChatRunSession: async (
      options: Parameters<typeof readChatRunSession>[1],
    ): Promise<Result<string | null, DatabaseError>> =>
      await Result.tryPromise({
        try: async () => await readChatRunSession(db, options),
        catch: toDatabaseError,
      }),
    /** The thread's run that asked request `requestId`. */
    readChatRunForRequest: async (
      options: Parameters<typeof readChatRunForRequest>[1],
    ): Promise<Result<ChatRunForRequest | null, DatabaseError>> =>
      await Result.tryPromise({
        try: async () => await readChatRunForRequest(db, options),
        catch: toDatabaseError,
      }),
    /** Undo the file changes of the thread's newest turn on its computer. */
    requestFolderRestore: async (options: TurnRestoreOptions) =>
      await requestRestore(deps, options),
    /** Whether the turn can be undone, and its undo; `null` for another's turn. */
    readFolderRestore: async (
      options: TurnRestoreOptions,
    ): Promise<Result<TurnFolderRestore | null, DatabaseError>> =>
      await Result.tryPromise({
        try: async () =>
          await readTurnFolderRestore(db, { ...options, now: deps.now() }),
        catch: toDatabaseError,
      }),
    /** Record how far a chat turn read the run; it only moves forward. */
    recordChatReadSeq: async (
      options: Parameters<typeof recordChatReadSeq>[1],
    ): Promise<Result<void, DatabaseError>> =>
      await Result.tryPromise({
        try: async () => {
          await recordChatReadSeq(db, options);
        },
        catch: toDatabaseError,
      }),
  };
};

export type DesktopRunnerControl = ReturnType<
  typeof createDesktopRunnerControl
>;
