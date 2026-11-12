import * as v from "valibot";

import type { AgentHarness } from "./agent-harness";
import { apiDateTimeSchema } from "./api-date";
import {
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE,
  DESKTOP_RUNNER_HARNESS_STATE,
  DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH,
  DESKTOP_RUNNER_REASONING_EFFORTS,
  type DesktopRunnerApprovalMode,
  type DesktopRunnerHarnessReport,
} from "./desktop-runner";
import { USER_FILE_URL_PREFIX } from "./user-file-url";

/**
 * Where a chat turn runs. `cloud` is stella's own model path and the default;
 * `local` hands the turn to a coding-agent harness on one of the member's
 * connected computers, which streams it back through the same turn pipeline.
 */
export const CHAT_RUN_TARGET_KIND = {
  cloud: "cloud",
  local: "local",
} as const;

/**
 * Harnesses a chat turn can run on a computer: the ones the desktop has an
 * adapter for. A harness id outside this list is refused at the boundary.
 */
export const CHAT_LOCAL_RUN_HARNESSES = [
  "codex",
  "claude-code",
] as const satisfies readonly AgentHarness[];
export type ChatLocalRunHarness = (typeof CHAT_LOCAL_RUN_HARNESSES)[number];

export const isChatLocalRunHarness = (
  harness: AgentHarness,
): harness is ChatLocalRunHarness =>
  CHAT_LOCAL_RUN_HARNESSES.some((candidate) => candidate === harness);

/** Matches the runner protocol's model id bound. */
const localModelSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));

export const chatLocalRunTargetSchema = v.strictObject({
  kind: v.literal("local"),
  harness: v.picklist(CHAT_LOCAL_RUN_HARNESSES),
  model: localModelSchema,
  /**
   * How much the run asks before it acts; `ask` when omitted. Only a mode
   * the computer reports for the harness is accepted.
   */
  approvals: v.optional(
    v.picklist(DESKTOP_RUNNER_APPROVAL_MODES),
    DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE,
  ),
  /**
   * The reasoning effort each turn asks the model for; `null`, or omitted,
   * leaves it to the harness. Only an effort the computer reports for the
   * model is accepted.
   */
  reasoningEffort: v.optional(
    v.nullable(v.picklist(DESKTOP_RUNNER_REASONING_EFFORTS)),
    null,
  ),
});
export type ChatLocalRunTarget = v.InferOutput<typeof chatLocalRunTargetSchema>;

/**
 * The most an organization lets a local run do without asking. Until an
 * administrator lowers it every mode is allowed, so a new setting changes
 * nothing for an organization that never chose one.
 */
export const CHAT_LOCAL_RUN_DEFAULT_MAX_APPROVALS =
  "full_auto" satisfies DesktopRunnerApprovalMode;

/**
 * Whether `mode` asks at least as much as `ceiling` allows. The modes are
 * ordered by how much a run does on its own, `ask < auto < full_auto`, which
 * is the order `DESKTOP_RUNNER_APPROVAL_MODES` lists them in.
 */
export const isApprovalModeWithin = (
  mode: DesktopRunnerApprovalMode,
  ceiling: DesktopRunnerApprovalMode,
): boolean =>
  DESKTOP_RUNNER_APPROVAL_MODES.indexOf(mode) <=
  DESKTOP_RUNNER_APPROVAL_MODES.indexOf(ceiling);

/**
 * The mode a turn runs in under `ceiling`: its own when the ceiling allows
 * it, otherwise the highest mode the ceiling allows among `offered` (the
 * modes the computer can run the harness in, when known), and Ask, which
 * every harness supports, when none is.
 */
export const approvalModeWithin = ({
  mode,
  ceiling,
  offered,
}: {
  mode: DesktopRunnerApprovalMode;
  ceiling: DesktopRunnerApprovalMode;
  offered?: readonly DesktopRunnerApprovalMode[] | undefined;
}): DesktopRunnerApprovalMode =>
  isApprovalModeWithin(mode, ceiling)
    ? mode
    : (DESKTOP_RUNNER_APPROVAL_MODES.findLast(
        (candidate) =>
          isApprovalModeWithin(candidate, ceiling) &&
          (offered === undefined || offered.includes(candidate)),
      ) ?? DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE);

export const chatRunTargetSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal(CHAT_RUN_TARGET_KIND.cloud) }),
  chatLocalRunTargetSchema,
]);
export type ChatRunTarget = v.InferOutput<typeof chatRunTargetSchema>;

export const CHAT_CLOUD_RUN_TARGET = {
  kind: CHAT_RUN_TARGET_KIND.cloud,
} as const satisfies ChatRunTarget;

/**
 * Why a turn bound for a computer was refused before it started. The send
 * answers with one of these as its error `code`; nothing falls back to cloud.
 */
export const CHAT_LOCAL_RUN_REFUSAL = {
  /** Running chat turns on a computer is not enabled for this member. */
  unavailable: "local_run_unavailable",
  /** None of the member's computers has a runner connected. */
  noComputer: "local_run_no_computer",
  /** The computer is connected but the harness cannot take a run now. */
  harnessUnavailable: "local_run_harness_unavailable",
  /** The harness no longer offers the chosen model. */
  modelUnavailable: "local_run_model_unavailable",
  /** The harness does not offer the chosen reasoning effort for the model. */
  reasoningEffortUnavailable: "local_run_reasoning_effort_unavailable",
  /** The computer cannot run the harness in the chosen approval mode. */
  approvalsUnavailable: "local_run_approvals_unavailable",
  /** The organization does not let a run go that far without asking. */
  approvalsAboveLimit: "local_run_approvals_above_limit",
  /** The turn does not fit what one run may carry. */
  tooLarge: "local_run_too_large",
  /** A turn cannot both run in the agent sandbox and on a computer. */
  conflictingRunMode: "local_run_conflicting_run_mode",
} as const;
export type ChatLocalRunRefusal =
  (typeof CHAT_LOCAL_RUN_REFUSAL)[keyof typeof CHAT_LOCAL_RUN_REFUSAL];

/** One harness on one computer, as its runner last reported it. */
export type ChatLocalHarnessReadiness = DesktopRunnerHarnessReport & {
  id: ChatLocalRunHarness;
};

/** One of the member's computers that has held a runner socket. */
export type ChatLocalRunnerReadiness = {
  desktopId: string;
  /** Whether its runner socket is open and was seen recently. */
  connected: boolean;
  lastSeenAt: string;
  harnesses: ChatLocalHarnessReadiness[];
};

/**
 * What the composer may offer for local runs. `hidden` when the member cannot
 * run chat turns on a computer at all; the composer then shows no option.
 * `maxApprovals` is the most the organization lets a run do without asking.
 */
export type ChatLocalRunReadiness =
  | { status: "hidden" }
  | {
      status: "enabled";
      runners: ChatLocalRunnerReadiness[];
      maxApprovals: DesktopRunnerApprovalMode;
    };

export const CHAT_LOCAL_HARNESS_STATE = DESKTOP_RUNNER_HARNESS_STATE;

// A local run's blocking question, its answers and the rule they are held to
// live in a leaf module, so a client that only answers a question does not
// load the runner protocol.
export {
  CHAT_LOCAL_RUN_QUESTION_TOOL,
  chatLocalRunAnswersRefusal,
  chatLocalRunQuestionReplySchema,
  chatLocalRunQuestionSchema,
  chatLocalRunQuestionsSchema,
} from "./chat-local-run-question";
export type {
  ChatLocalRunQuestion,
  ChatLocalRunQuestionReply,
} from "./chat-local-run-question";

/**
 * The tool call a message the member steered a running local turn with is
 * persisted as, in that turn's answer where the harness took it: a call the
 * harness ran, whose input is the member's text and whose result says it was
 * delivered. The API mints it from its own record of what was sent; a
 * desktop only reports that the harness took it.
 */
export const CHAT_LOCAL_RUN_STEER_TOOL = "user_message";

export const chatLocalRunSteerInputSchema = v.strictObject({
  text: v.pipe(v.string(), v.minLength(1)),
});
export type ChatLocalRunSteerInput = v.InferOutput<
  typeof chatLocalRunSteerInputSchema
>;

/** The call id of the steer `inputId` delivered; one input, one call. */
export const chatLocalRunSteerCallId = (inputId: string) => `steer_${inputId}`;

/**
 * The CUSTOM stream event that tells the chat what became of a message it
 * steered a running local turn with: `steered` once the harness took it
 * (the answer holds it from there on), `refused` when it did not. A turn
 * that ends without either did not take it. A rejoined stream replays these
 * from the run log, so a reload settles the same way.
 */
export const CHAT_LOCAL_RUN_STEER_EVENT = "stella.local-run.steer";

export const CHAT_LOCAL_RUN_STEER_STATUSES = ["steered", "refused"] as const;

export const chatLocalRunSteerEventSchema = v.strictObject({
  inputId: v.pipe(v.string(), v.uuid()),
  status: v.picklist(CHAT_LOCAL_RUN_STEER_STATUSES),
});
export type ChatLocalRunSteerEvent = v.InferOutput<
  typeof chatLocalRunSteerEventSchema
>;

/** What the chat asks to steer a running local turn with. */
export const chatLocalRunSteerRequestSchema = v.strictObject({
  /** The queued message's id, so a repeat steers once. */
  inputId: v.pipe(v.string(), v.uuid()),
  text: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(DESKTOP_RUNNER_MAX_INPUT_TEXT_LENGTH),
  ),
});
export type ChatLocalRunSteerRequest = v.InferOutput<
  typeof chatLocalRunSteerRequestSchema
>;

/**
 * Whether the running turn will be steered: `queued` once the computer was
 * handed the message (the turn's stream then says whether it took it),
 * `unavailable` when this turn cannot be steered and the chat sends the
 * message the usual way.
 */
export const CHAT_LOCAL_RUN_STEER_OUTCOMES = ["queued", "unavailable"] as const;
export type ChatLocalRunSteerOutcome =
  (typeof CHAT_LOCAL_RUN_STEER_OUTCOMES)[number];

/**
 * The CUSTOM stream event a turn running on a computer sends while its run
 * waits for the computer to pick it up, once it did, and when that computer
 * goes away mid-turn and is back. The turn stays open while the computer is
 * away and continues once it reconnects, so the chat shows the wait instead
 * of a stalled answer; a run no computer picks up in time ends the turn as
 * `local_runner_not_reached`. A rejoined stream replays these events from the
 * run log, so a reload shows the same state.
 */
export const CHAT_LOCAL_RUN_COMPUTER_EVENT = "stella.local-run.computer";

/**
 * Where a turn on the member's computer stands: `delivering` until the
 * computer picks the run up (`since` is when the turn was sent), `waiting`
 * while a computer that took it is away, `connected` otherwise.
 */
export const CHAT_LOCAL_RUN_COMPUTER_STATUSES = [
  "delivering",
  "waiting",
  "connected",
] as const;
export type ChatLocalRunComputerStatus =
  (typeof CHAT_LOCAL_RUN_COMPUTER_STATUSES)[number];

export const chatLocalRunComputerEventSchema = v.variant("status", [
  v.strictObject({
    status: v.literal("delivering"),
    since: apiDateTimeSchema,
  }),
  v.strictObject({ status: v.literal("waiting") }),
  v.strictObject({ status: v.literal("connected") }),
]);
export type ChatLocalRunComputerEvent = v.InferOutput<
  typeof chatLocalRunComputerEventSchema
>;
/** What the chat shows while a turn waits on the member's computer. */
export type ChatLocalRunComputerWait = Exclude<
  ChatLocalRunComputerEvent,
  { status: "connected" }
>;

/**
 * The run-finished metadata key under which a turn that ran on the member's
 * computer reports how full the harness's context was after its last model
 * request, against the model's context window, as the harness reported both.
 * The chat's context meter shows it for a thread whose turns run there.
 */
export const CHAT_LOCAL_RUN_CONTEXT_METADATA_KEY = "localRunContext";

/** No model context window is anywhere near this. */
const MAX_CONTEXT_TOKENS = 100_000_000;

export const chatLocalRunContextSchema = v.strictObject({
  usedTokens: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(0),
    v.maxValue(MAX_CONTEXT_TOKENS),
  ),
  windowTokens: v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(MAX_CONTEXT_TOKENS),
  ),
});
export type ChatLocalRunContext = v.InferOutput<
  typeof chatLocalRunContextSchema
>;

/**
 * What a turn on a computer tells the chat about the files it handed back, as
 * metadata on the answer: every stream processor merges it and a rejoin's
 * snapshot keeps it, so a live answer and a rejoined one read the same. The
 * server alone writes these keys; a desktop's metadata never reaches a message.
 *
 * - `localRunFiles`: the shared files, each already checked against the
 *   thread and its owner. Live only: the stored answer holds them as parts.
 * - `localRunFilesNotShared`: the names of files left on the computer. Stored.
 */
export const CHAT_LOCAL_RUN_FILES_METADATA_KEY = "localRunFiles";
export const CHAT_LOCAL_RUN_FILES_NOT_SHARED_METADATA_KEY =
  "localRunFilesNotShared";

export const chatLocalRunFileSchema = v.strictObject({
  url: v.pipe(v.string(), v.startsWith(USER_FILE_URL_PREFIX)),
  filename: v.string(),
  mimeType: v.string(),
  placeholder: v.optional(v.string()),
});
export type ChatLocalRunFile = v.InferOutput<typeof chatLocalRunFileSchema>;

export const chatLocalRunFilesNotSharedSchema = v.array(v.string());

/** The message part a shared file reads as, live and once stored. */
export const chatLocalRunFilePart = ({
  url,
  filename,
  mimeType,
  placeholder,
}: ChatLocalRunFile) =>
  ({
    type: mimeType.startsWith("image/") ? "image" : "document",
    source: { type: "url", value: url, mimeType },
    metadata: {
      filename,
      ...(placeholder === undefined ? {} : { placeholder }),
    },
  }) as const;

/**
 * The file parts `metadata` adds to a message's `parts`. A file already among
 * them adds none, so a stored answer that also carries the live metadata (a
 * rejoin, a page's own message handed back to the client) shows it once.
 */
export const chatLocalRunFilePartsOf = (
  metadata: unknown,
  parts: readonly { type: string; source?: { value?: unknown } }[],
) => {
  if (typeof metadata !== "object" || metadata === null) {
    return [];
  }
  const listed = v.safeParse(
    v.array(chatLocalRunFileSchema),
    Reflect.get(metadata, CHAT_LOCAL_RUN_FILES_METADATA_KEY),
  );
  if (!listed.success) {
    return [];
  }
  const present = new Set(parts.map((part) => part.source?.value));
  return listed.output
    .filter(({ url }) => !present.has(url))
    .map(chatLocalRunFilePart);
};

/**
 * The run-error metadata key under which a turn that ended on the harness's
 * usage limit says when the limit resets, as the harness reported it. The
 * chat shows the time; a limit without a known reset carries none.
 */
export const CHAT_LOCAL_RUN_LIMIT_METADATA_KEY = "localRunLimit";

export const chatLocalRunLimitSchema = v.strictObject({
  resetsAt: v.pipe(apiDateTimeSchema, v.maxLength(32)),
});
export type ChatLocalRunLimit = v.InferOutput<typeof chatLocalRunLimitSchema>;
