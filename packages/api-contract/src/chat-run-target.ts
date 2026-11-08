import * as v from "valibot";

import type { AgentHarness } from "./agent-harness";
import { apiDateTimeSchema } from "./api-date";
import {
  DESKTOP_RUNNER_ANSWER_LIMITS,
  DESKTOP_RUNNER_APPROVAL_MODES,
  DESKTOP_RUNNER_DEFAULT_APPROVAL_MODE,
  DESKTOP_RUNNER_HARNESS_STATE,
  type DesktopRunnerHarnessReport,
  desktopRunnerQuestionAnswersSchema,
  desktopRunnerQuestionIdSchema,
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
});
export type ChatLocalRunTarget = v.InferOutput<typeof chatLocalRunTargetSchema>;

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
  /** The computer cannot run the harness in the chosen approval mode. */
  approvalsUnavailable: "local_run_approvals_unavailable",
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
 */
export type ChatLocalRunReadiness =
  | { status: "hidden" }
  | { status: "enabled"; runners: ChatLocalRunnerReadiness[] };

export const CHAT_LOCAL_HARNESS_STATE = DESKTOP_RUNNER_HARNESS_STATE;

/**
 * The resume payload that answers a local run's blocking question: the
 * interrupt the question paused the turn with (`metadata.kind: "question"`,
 * its questions in `metadata.questions`) is resumed with `status: "resolved"`
 * and this payload. Answers are keyed by question id and hold option labels
 * or free text; every question asked takes at least one, and a question
 * without free text takes only its option labels. A `cancelled` resume
 * stops the run's turn instead of answering.
 */
export const chatLocalRunQuestionReplySchema = v.strictObject({
  answers: desktopRunnerQuestionAnswersSchema,
});
export type ChatLocalRunQuestionReply = v.InferOutput<
  typeof chatLocalRunQuestionReplySchema
>;

/**
 * The tool call a local run's question is persisted as, for every harness:
 * Codex's native item name, which a Claude Code `AskUserQuestion` takes too.
 */
export const CHAT_LOCAL_RUN_QUESTION_TOOL = "request_user_input";

/**
 * One question of a local run's blocking question, as its interrupt carries
 * it (`metadata.questions`). An answer names an option by its `label`, which
 * is the harness's native reply. `multiSelect` lets one answer pick several
 * options; `allowsFreeText` lets it be the member's own words; a `secret`
 * answer is never shown back.
 */
export const chatLocalRunQuestionSchema = v.object({
  id: desktopRunnerQuestionIdSchema,
  header: v.string(),
  prompt: v.string(),
  options: v.array(v.object({ label: v.string(), description: v.string() })),
  allowsFreeText: v.boolean(),
  multiSelect: v.boolean(),
  secret: v.boolean(),
});
/**
 * The questions one blocking question asks: at least one, each under its own
 * id, and no more than one answer may carry
 * (`DESKTOP_RUNNER_ANSWER_LIMITS`), so every pause can be answered.
 */
export const chatLocalRunQuestionsSchema = v.pipe(
  v.array(chatLocalRunQuestionSchema),
  v.minLength(1),
  v.maxLength(DESKTOP_RUNNER_ANSWER_LIMITS.maxQuestions),
  v.check(
    (questions) =>
      new Set(questions.map(({ id }) => id)).size === questions.length,
    "Each question has its own id",
  ),
  v.check(
    (questions) =>
      questions.every(
        ({ allowsFreeText, options }) => allowsFreeText || options.length > 0,
      ),
    "Each question offers an option or free text",
  ),
);
export type ChatLocalRunQuestion = Readonly<
  Omit<v.InferOutput<typeof chatLocalRunQuestionSchema>, "options">
> & {
  readonly options: readonly { label: string; description: string }[];
};

/**
 * Why `answers` do not answer `questions`, or `null` when they do. Every
 * question takes at least one answer, a single-choice question takes only one,
 * a question without free text takes only its option labels, and only the
 * questions asked are answered. The browser checks it before sending, the API
 * before an answer leaves for the computer, and every harness before replying,
 * so an answer the harness would refuse never leaves its run waiting.
 */
export const chatLocalRunAnswersRefusal = (
  questions: readonly ChatLocalRunQuestion[],
  answers: Readonly<Record<string, readonly string[]>>,
): string | null => {
  const asked = new Set(questions.map(({ id }) => id));
  const unasked = Object.keys(answers).find((id) => !asked.has(id));
  if (unasked !== undefined) {
    return `Question ${unasked} was not asked.`;
  }
  for (const question of questions) {
    const given = Object.hasOwn(answers, question.id)
      ? (answers[question.id] ?? [])
      : [];
    if (given.length === 0) {
      return `Question ${question.id} has no answer.`;
    }
    if (!question.multiSelect && given.length > 1) {
      return `Question ${question.id} takes one answer.`;
    }
    const labels = new Set(question.options.map(({ label }) => label));
    if (!question.allowsFreeText && given.some((a) => !labels.has(a))) {
      return `Question ${question.id} takes one of its options.`;
    }
  }
  return null;
};

/**
 * The CUSTOM stream event a turn running on a computer sends when that
 * computer goes away mid-turn and when it is back. The turn stays open while
 * the computer is away and continues once it reconnects, so the chat shows
 * the wait instead of a stalled answer. A rejoined stream replays these
 * events from the run log, so a reload shows the same state.
 */
export const CHAT_LOCAL_RUN_COMPUTER_EVENT = "stella.local-run.computer";

export const CHAT_LOCAL_RUN_COMPUTER_STATUSES = [
  "waiting",
  "connected",
] as const;
export type ChatLocalRunComputerStatus =
  (typeof CHAT_LOCAL_RUN_COMPUTER_STATUSES)[number];

export const chatLocalRunComputerEventSchema = v.strictObject({
  status: v.picklist(CHAT_LOCAL_RUN_COMPUTER_STATUSES),
});
export type ChatLocalRunComputerEvent = v.InferOutput<
  typeof chatLocalRunComputerEventSchema
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
