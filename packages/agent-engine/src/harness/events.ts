/**
 * What a local harness reports while it runs one turn, in a form shared by
 * every harness. Adapters translate their native protocol into these events;
 * `stream-chunks.ts` is the one place that turns them into TanStack chunks,
 * so a Codex and a Claude turn persist through the same message parts.
 */

import * as v from "valibot";

import { chatLocalRunApprovalMessage } from "@stll/api-contract/chat-local-run-tool";
import type { ChatLocalRunQuestion } from "@stll/api-contract/chat-run-target";
import type {
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_APPROVAL_KINDS,
  DESKTOP_RUNNER_RUN_OUTCOMES,
} from "@stll/api-contract/desktop-runner";

import type { HarnessStepOutput } from "./step-output";

type DesktopRunnerApprovalDecision =
  (typeof DESKTOP_RUNNER_APPROVAL_DECISIONS)[number];
type DesktopRunnerApprovalKind = (typeof DESKTOP_RUNNER_APPROVAL_KINDS)[number];
type DesktopRunnerRunOutcome = (typeof DESKTOP_RUNNER_RUN_OUTCOMES)[number];

const HarnessSessionIdSchema = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.brand("HarnessSessionId"),
);

/**
 * The harness's own id for a conversation: a Codex thread id or a Claude
 * session id. Only an adapter mints one, from what the harness reported, so a
 * Stella thread or run id cannot be passed where a resumable session belongs.
 */
export type HarnessSessionId = v.InferOutput<typeof HarnessSessionIdSchema>;

export const harnessSessionId = (nativeId: string): HarnessSessionId =>
  v.parse(HarnessSessionIdSchema, nativeId);

/**
 * How the turn's conversation context was established. `resume_unavailable`
 * is the visible fallback: the requested native session could not be resumed,
 * so the turn started a new session from the portable transcript instead.
 */
export type HarnessContinuation =
  | { type: "fresh" }
  | { type: "resumed" }
  | {
      type: "resume_unavailable";
      reason: "session_not_found" | "resume_rejected";
      message: string;
    };

/**
 * A tool the harness ran itself. `name` is the name a cloud chat turn gives
 * the same tool, built by `tool-parts.ts`: a stella tool by its registry name,
 * any other MCP tool as `mcp__<server>__<tool>`, and a harness-native action
 * by a name no stella tool uses (`HARNESS_TOOL_NAMES`).
 */
export type HarnessToolCall = {
  id: string;
  name: string;
  input: unknown;
  /**
   * What the harness asked of a native tool whose record leaves it out, such
   * as the file a read opened. It stays in this process: only the skill filter
   * reads it, and it is not part of what a turn reports.
   */
  localInput?: unknown;
  /**
   * The harness's id of the subagent step that made the call; absent on the
   * main thread. Reported beside the call, never inside its input.
   */
  parentCallId?: string;
};

export type HarnessToolResult = {
  content: string;
  /** `cancelled`: the harness never ran the call to its end because the
   *  turn was stopped or a new message cut it off; not a failure. */
  status: "succeeded" | "failed" | "cancelled";
  /**
   * What a native step produced (a command's output, a change's diff). It
   * is the step's content: the sidecar keeps it and sends it to stella beside
   * the turn's events, and it is not part of what a turn reports.
   */
  localOutput?: HarnessStepOutput;
};

/**
 * One reply the harness accepts for an approval: the runner protocol's
 * `decision`, bound to the harness's native reply `id`, which is sent back
 * verbatim. A decision the harness does not offer is not listed.
 */
export type HarnessApprovalOption = {
  id: string;
  decision: DesktopRunnerApprovalDecision;
};

export type HarnessApprovalRequest = {
  requestId: string;
  kind: DesktopRunnerApprovalKind;
  /** The tool call awaiting approval; it is opened first if not yet started. */
  toolCall: HarnessToolCall;
  reason: string | null;
  options: readonly HarnessApprovalOption[];
};

/**
 * What an approval asks the user to allow, from what chat keeps of the call
 * (`chatLocalRunApprovalMessage`): a command's shown command line, else the
 * harness's shown reason, or the tool's name. Never more of a step than its
 * call shows, so a heredoc's text is never in it.
 */
export const approvalMessage = (request: HarnessApprovalRequest): string =>
  chatLocalRunApprovalMessage({
    toolName: request.toolCall.name,
    input: request.toolCall.input,
    reason: request.reason,
  });

/** One question of a blocking question, as the chat contract carries it. */
export type HarnessQuestion = ChatLocalRunQuestion;

/**
 * `response` questions block the turn and are answered through `respond`.
 * `next_message` questions do not block: the turn completes and the user
 * answers with their next message, which starts a new turn.
 */
export type HarnessQuestionRequest = {
  requestId: string;
  toolCall: HarnessToolCall;
  questions: readonly HarnessQuestion[];
  answerWith: "response" | "next_message";
};

/**
 * How full the model's context was after the turn's last model request, and
 * the model's context window, both as the harness reported them.
 */
export type HarnessContextUsage = {
  usedTokens: number;
  windowTokens: number;
};

/**
 * The context a harness reported, or `null` without a window to measure it
 * against: a count that is not a whole number of tokens reports nothing.
 */
export const harnessContextUsage = (
  usedTokens: number,
  windowTokens: number | null | undefined,
): HarnessContextUsage | null =>
  windowTokens === null ||
  windowTokens === undefined ||
  !Number.isSafeInteger(windowTokens) ||
  windowTokens <= 0 ||
  !Number.isSafeInteger(usedTokens) ||
  usedTokens < 0
    ? null
    : { usedTokens, windowTokens };

export type HarnessUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  /** `null` when the harness reported no context window. */
  context: HarnessContextUsage | null;
};

/**
 * Why a turn could not finish. Every member is a state Stella can show and
 * act on (sign in again, wait for the limit to reset, update the harness);
 * none of them is a reason to move the run elsewhere.
 */
export type HarnessFailure =
  | { type: "auth_required"; message: string }
  | { type: "usage_limit"; message: string; resetsAt: string | null }
  /**
   * The model stayed at capacity through every retry: a transient state of
   * the provider, unlike a usage limit, which is the member's own allowance.
   */
  | { type: "model_at_capacity"; message: string }
  | { type: "provider_error"; message: string; code: string }
  | {
      type: "harness_exited";
      message: string;
      exitCode: number | null;
      signal: string | null;
    }
  | { type: "protocol_violation"; message: string }
  /**
   * The run's approval mode needs the harness's OS sandbox and the sandbox
   * could not start; the run never runs without it.
   */
  | { type: "sandbox_unavailable"; message: string }
  /**
   * The harness kept retrying the provider with nothing else happening for
   * longer than a turn may wait; the turn ends instead of waiting on.
   */
  | { type: "retry_stalled"; message: string }
  /** The harness could not reach stella's MCP server, so it has none of
   *  stella's tools; the turn does not run without them. */
  | { type: "tools_unavailable"; message: string };

export type HarnessEvent =
  | {
      type: "session.started";
      sessionId: HarnessSessionId;
      continuation: HarnessContinuation;
    }
  | { type: "text.delta"; messageId: string; delta: string }
  | { type: "text.completed"; messageId: string; text: string }
  | { type: "reasoning.completed"; messageId: string; text: string }
  | { type: "tool.started"; toolCall: HarnessToolCall }
  | {
      type: "tool.completed";
      toolCall: HarnessToolCall;
      result: HarnessToolResult;
    }
  | { type: "approval.requested"; request: HarnessApprovalRequest }
  | { type: "question.requested"; request: HarnessQuestionRequest }
  /** A pending approval or blocking question was answered or withdrawn. */
  | { type: "interaction.resolved"; requestId: string }
  /** A transient provider error the harness is retrying on its own. */
  | { type: "retrying"; message: string }
  | { type: "turn.completed"; usage: HarnessUsage | null }
  | { type: "turn.interrupted" }
  | { type: "turn.failed"; failure: HarnessFailure };

/**
 * The runner protocol's outcome for each failure. Interrupted turns report
 * `interrupted`; the runner reports `cancelled` when the stop was a cancel.
 */
export const HARNESS_FAILURE_OUTCOME = {
  auth_required: "needs_login",
  usage_limit: "limit_reached",
  model_at_capacity: "failed",
  provider_error: "failed",
  harness_exited: "failed",
  protocol_violation: "failed",
  sandbox_unavailable: "failed",
  retry_stalled: "failed",
  tools_unavailable: "failed",
} as const satisfies Record<HarnessFailure["type"], DesktopRunnerRunOutcome>;
