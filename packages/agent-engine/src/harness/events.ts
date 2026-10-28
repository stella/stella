/**
 * What a local harness reports while it runs one turn, in a form shared by
 * every harness. Adapters translate their native protocol into these events;
 * `stream-chunks.ts` is the one place that turns them into TanStack chunks,
 * so a Codex and a Claude turn persist through the same message parts.
 */

import * as v from "valibot";

import type {
  DESKTOP_RUNNER_APPROVAL_DECISIONS,
  DESKTOP_RUNNER_APPROVAL_KINDS,
  DESKTOP_RUNNER_RUN_OUTCOMES,
} from "@stll/api-contract/desktop-runner";

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
 * A tool the harness ran itself. `name` follows the cloud engine's naming:
 * MCP tools are `mcp__<server>__<tool>`, harness-native actions use the
 * native item kind (`command_execution`, `file_change`, `web_search`).
 */
export type HarnessToolCall = {
  id: string;
  name: string;
  input: unknown;
};

export type HarnessToolResult = {
  content: string;
  status: "succeeded" | "failed";
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

export type HarnessQuestion = {
  id: string;
  header: string;
  prompt: string;
  /** Answers name an option by its `label`, which is the native reply. */
  options: readonly { label: string; description: string }[];
  allowsFreeText: boolean;
  secret: boolean;
};

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

export type HarnessUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

/**
 * Why a turn could not finish. Every member is a state Stella can show and
 * act on (sign in again, wait for the limit to reset, update the harness);
 * none of them is a reason to move the run elsewhere.
 */
export type HarnessFailure =
  | { type: "auth_required"; message: string }
  | { type: "usage_limit"; message: string; resetsAt: string | null }
  | { type: "provider_error"; message: string; code: string }
  | {
      type: "harness_exited";
      message: string;
      exitCode: number | null;
      signal: string | null;
    }
  | { type: "protocol_violation"; message: string };

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

export type HarnessEventType = HarnessEvent["type"];

/**
 * The runner protocol's outcome for each failure. Interrupted turns report
 * `interrupted`; the runner reports `cancelled` when the stop was a cancel.
 */
export const HARNESS_FAILURE_OUTCOME = {
  auth_required: "needs_login",
  usage_limit: "limit_reached",
  provider_error: "failed",
  harness_exited: "failed",
  protocol_violation: "failed",
} as const satisfies Record<HarnessFailure["type"], DesktopRunnerRunOutcome>;
