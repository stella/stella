import { panic, Result } from "better-result";
import path from "node:path";
import * as v from "valibot";

import { chatLocalRunToolResultContent } from "@stll/api-contract/chat-local-run-tool";
import type { DESKTOP_RUNNER_APPROVAL_DECISIONS } from "@stll/api-contract/desktop-runner";
import { isPathInside } from "@stll/portable-path";

import type {
  HarnessInteractionResponse,
  HarnessRespondError,
  HarnessRunPolicy,
  HarnessSteerInput,
  HarnessTurn,
} from "../adapter";
import {
  type HarnessApprovalOption,
  type HarnessApprovalRequest,
  harnessContextUsage,
  type HarnessContinuation,
  type HarnessEvent,
  type HarnessFailure,
  harnessSessionId,
  type HarnessToolCall,
  type HarnessUsage,
} from "../events";
import { HARNESS_TOOL_NAMES, nativeToolCall } from "../tool-parts";
import {
  type Detached,
  type HarnessExit,
  HarnessTurnLifecycle,
  respondError,
} from "../turn-lifecycle";
import type { AcpAnswer, AcpClient, AcpHandlers } from "./client";
import {
  ACP_AGENT_NOTIFICATIONS,
  ACP_AGENT_REQUESTS,
  ACP_ERROR,
  acpBlockText,
  type AcpPermissionOutcome,
  AcpPromptResponseSchema,
  type AcpRequestId,
  AcpRequestPermissionSchema,
  AcpSessionNotificationSchema,
  type AcpSessionUpdate,
  AcpSessionUpdateSchema,
} from "./protocol";
import {
  type AcpMcpNames,
  type AcpToolCallState,
  harnessToolCall,
  harnessToolResult,
  isFinished,
  mergeToolCall,
  toolCallChanged,
} from "./tool-calls";

/** The name a plan step is shown under; ACP gives plans no tool of their own. */
const PLAN_TOOL = "plan";

type ApprovalDecision = (typeof DESKTOP_RUNNER_APPROVAL_DECISIONS)[number];

/** Each ACP permission option kind as the decision chat offers for it. */
const DECISION_OF_OPTION: Readonly<Record<string, ApprovalDecision>> = {
  allow_once: "approve",
  allow_always: "approve_for_session",
  reject_once: "deny",
};

/** What stella does with a permission request before the member sees it. */
export type PermissionDisposition = "allow" | "deny" | "ask";

const READ_KINDS: ReadonlySet<string> = new Set(["read", "search", "think"]);
const WRITE_KINDS: ReadonlySet<string> = new Set(["edit", "delete", "move"]);

/**
 * stella's answer to a permission request at the turn's approval mode. A
 * step that touches a path the turn may not read is refused in every mode;
 * reading inside the run's folder never asks; writing inside it and fetching
 * from the web do not ask in auto; anything else (a command, a step outside
 * the folder, an MCP tool the agent asks about) goes to the member.
 */
export const permissionDisposition = ({
  call,
  policy,
  workspaceDir,
  unreadablePaths,
}: {
  call: AcpToolCallState;
  policy: HarnessRunPolicy;
  workspaceDir: string;
  unreadablePaths: readonly string[];
}): PermissionDisposition => {
  const paths = call.locations.map((location) => location.path);
  const resolved = paths.map((file) =>
    path.isAbsolute(file) ? file : path.resolve(workspaceDir, file),
  );
  if (
    resolved.some((file) =>
      unreadablePaths.some(
        (unreadable) =>
          isPathInside(unreadable, file) && !isPathInside(workspaceDir, file),
      ),
    )
  ) {
    return "deny";
  }
  const inside = resolved.every((file) => isPathInside(workspaceDir, file));
  const kind = call.kind ?? "other";
  if (READ_KINDS.has(kind) && inside) {
    return "allow";
  }
  if (WRITE_KINDS.has(kind) && inside && resolved.length > 0) {
    return policy.approvals === "auto" ? "allow" : "ask";
  }
  if (kind === "fetch" && resolved.length === 0) {
    return policy.approvals === "auto" ? "allow" : "ask";
  }
  return "ask";
};

const approvalKindOf = (
  call: AcpToolCallState,
  shown: HarnessToolCall,
): HarnessApprovalRequest["kind"] => {
  if (shown.name === HARNESS_TOOL_NAMES.commandExecution) {
    return "command";
  }
  if (shown.name === HARNESS_TOOL_NAMES.fileChange) {
    return "file_change";
  }
  return call.kind === null ||
    Object.values(HARNESS_TOOL_NAMES).some((name) => name === shown.name)
    ? "tool"
    : "mcp_tool";
};

type PendingPermission = {
  jsonRpcId: AcpRequestId;
  toolCallId: string;
  options: readonly HarnessApprovalOption[];
};

type TrackedCall = {
  state: AcpToolCallState;
  /** The call as chat shows it, fixed once it was opened. */
  shown: HarnessToolCall | null;
  done: boolean;
};

const ACP_FAILURE_OF_STOP: Readonly<
  Record<string, { code: string; message: string }>
> = {
  max_tokens: {
    code: "max_tokens",
    message: "The agent stopped: the model reached its output limit.",
  },
  max_turn_requests: {
    code: "max_turn_requests",
    message: "The agent stopped: the turn reached its limit of model requests.",
  },
  refusal: {
    code: "refusal",
    message: "The agent refused to continue this request.",
  },
};

export type AcpTurnOptions = {
  gracePeriodMs: number;
  detached: Detached;
  /** The agent's name in failures stella reports. */
  displayName: string;
  mcpNames: AcpMcpNames;
  policy: HarnessRunPolicy;
  workspaceDir: string;
  unreadablePaths: readonly string[];
  /** Called with a failed prompt's error text, for the adapter to read. */
  onPromptError: (message: string) => void;
};

type PromptUsage = NonNullable<
  v.InferOutput<typeof AcpPromptResponseSchema>["usage"]
>;

/**
 * One ACP turn: a `session/prompt` and the `session/update` notifications
 * of its session, as harness events. The prompt's answer ends the turn; the
 * shared lifecycle stops and ends the process.
 */
export class AcpTurnSession {
  private readonly lifecycle: HarnessTurnLifecycle<AcpClient>;
  private readonly options: AcpTurnOptions;
  private sessionId: string | null = null;
  /** Updates for a session being loaded replay its history: not this turn's. */
  private replaying: string | null = null;
  private readonly calls = new Map<string, TrackedCall>();
  private readonly permissions = new Map<string, PendingPermission>();
  private nextPermission = 1;
  private message: { id: string; text: string } | null = null;
  private messageCount = 0;
  private thought = "";
  private planCount = 0;
  private context: { used: number; size: number } | null = null;
  /**
   * The agent takes a prompt sent while one runs into the running turn: the
   * earlier prompt then ends and the turn goes on under the new one. Known
   * once the agent said its version.
   */
  private steering = false;
  /** The prompt whose answer ends the turn: the last one sent. */
  private latestPrompt = 0;
  /** What every answered prompt of the turn used, steered ones included. */
  private readonly promptUsage: PromptUsage[] = [];

  constructor(options: AcpTurnOptions) {
    this.options = options;
    this.lifecycle = new HarnessTurnLifecycle<AcpClient>({
      gracePeriodMs: options.gracePeriodMs,
      detached: options.detached,
      name: "acp-turn",
    });
  }

  readonly handlers: AcpHandlers = {
    notification: (method, params) => {
      this.notification(method, params);
    },
    request: (id, method, params) => {
      this.request(id, method, params);
    },
    violation: (message) => {
      this.closeCalls("interrupted");
      this.lifecycle.violation(message);
    },
    exit: (exit: HarnessExit) => {
      this.closeCalls("interrupted");
      this.lifecycle.exited(exit);
    },
  };

  attach(client: AcpClient) {
    this.lifecycle.attach(client);
  }

  abandon() {
    this.lifecycle.abandon();
  }

  /** Updates for `sessionId` are replayed history until `loaded`. */
  loading(sessionId: string) {
    this.replaying = sessionId;
  }

  loaded() {
    this.replaying = null;
  }

  steers(steering: boolean) {
    this.steering = steering;
  }

  /** The session the prompt runs in; announced before any of its output. */
  begin(sessionId: string, continuation: HarnessContinuation) {
    this.sessionId = sessionId;
    this.emit({
      type: "session.started",
      sessionId: harnessSessionId(sessionId),
      continuation,
    });
  }

  /** A prompt was sent; the last one's answer ends the turn. */
  prompted(answer: Promise<AcpAnswer>) {
    this.latestPrompt += 1;
    const prompt = this.latestPrompt;
    this.options.detached(
      (async () => {
        this.answered(prompt, await answer);
      })(),
      "acp-turn.prompt",
    );
  }

  /**
   * A steered prompt's predecessor ends as the agent hands the turn over;
   * only its usage counts.
   */
  private answered(prompt: number, answer: AcpAnswer) {
    if (Result.isOk(answer)) {
      const parsed = v.safeParse(AcpPromptResponseSchema, answer.value);
      if (
        parsed.success &&
        parsed.output.usage !== null &&
        parsed.output.usage !== undefined
      ) {
        this.promptUsage.push(parsed.output.usage);
      }
    }
    if (prompt === this.latestPrompt) {
      this.finish(answer);
    }
  }

  private steerWith(input: HarnessSteerInput) {
    const client = this.lifecycle.client;
    if (
      !this.steering ||
      client === null ||
      this.sessionId === null ||
      this.lifecycle.interrupting
    ) {
      this.lifecycle.settleInput(input.inputId, "rejected");
      return;
    }
    this.flushText();
    this.prompted(
      client.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text: input.text }],
      }),
    );
    this.lifecycle.settleInput(input.inputId, "accepted");
  }

  turn(): HarnessTurn {
    return this.lifecycle.turn({
      respond: (response) => this.respond(response),
      steer: (input: HarnessSteerInput) => {
        this.steerWith(input);
      },
      interrupt: async () => {
        await this.lifecycle.interrupt(async (client) => {
          this.cancelPermissions();
          if (this.sessionId !== null) {
            client.notify("session/cancel", { sessionId: this.sessionId });
          }
          return true;
        });
      },
    });
  }

  private emit(event: HarnessEvent) {
    this.lifecycle.emit(event);
  }

  private notification(method: string, params: unknown) {
    if (method !== ACP_AGENT_NOTIFICATIONS.update) {
      return;
    }
    const parsed = v.safeParse(AcpSessionNotificationSchema, params);
    if (!parsed.success) {
      this.handlers.violation(
        "The agent sent a session update without a session.",
      );
      return;
    }
    const { sessionId, update } = parsed.output;
    if (sessionId === this.replaying || sessionId !== this.sessionId) {
      return;
    }
    // A kind stella does not read, or one a newer protocol shaped
    // differently, is dropped: it never ends the turn.
    const known = v.safeParse(AcpSessionUpdateSchema, update);
    if (known.success) {
      this.update(known.output);
    }
  }

  private update(update: AcpSessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = acpBlockText(update.content);
        if (text === null || text === "") {
          return;
        }
        this.flushThought();
        if (this.message === null) {
          this.messageCount += 1;
          this.message = {
            id: `${this.sessionId ?? "acp"}:message:${String(this.messageCount)}`,
            text: "",
          };
        }
        this.message.text += text;
        this.emit({
          type: "text.delta",
          messageId: this.message.id,
          delta: text,
        });
        return;
      }
      case "agent_thought_chunk": {
        const text = acpBlockText(update.content);
        if (text !== null) {
          this.flushMessage();
          this.thought += text;
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const { sessionUpdate: _kind, ...fields } = update;
        this.toolCall(fields);
        return;
      }
      case "plan":
        this.plan(update.entries.map((entry) => entry.content));
        return;
      case "usage_update":
        this.context = { used: update.used, size: update.size };
        return;
      case "user_message_chunk":
      case "current_mode_update":
        return;
      default:
        update satisfies never;
        panic("Unhandled ACP session update");
    }
  }

  private flushMessage() {
    if (this.message !== null) {
      this.emit({
        type: "text.completed",
        messageId: this.message.id,
        text: this.message.text,
      });
      this.message = null;
    }
  }

  private flushThought() {
    const text = this.thought.trim();
    this.thought = "";
    if (text !== "") {
      this.messageCount += 1;
      this.emit({
        type: "reasoning.completed",
        messageId: `${this.sessionId ?? "acp"}:thought:${String(this.messageCount)}`,
        text,
      });
    }
  }

  private flushText() {
    this.flushMessage();
    this.flushThought();
  }

  private toolCall(fields: Parameters<typeof mergeToolCall>[1]) {
    const tracked = this.calls.get(fields.toolCallId);
    if (tracked?.done === true) {
      // Output arriving after the call ended does not reopen it.
      return;
    }
    const state = mergeToolCall(tracked?.state ?? null, fields);
    if (tracked !== undefined && !toolCallChanged(tracked.state, state)) {
      return;
    }
    const call: TrackedCall = tracked ?? { state, shown: null, done: false };
    call.state = state;
    this.calls.set(state.id, call);
    // A call opens once it runs: the input an agent streams in while the
    // call is pending is then complete.
    if (state.status !== "pending") {
      this.open(call);
    }
    if (isFinished(state)) {
      this.complete(call, state.status === "failed" ? "failed" : "completed");
    }
  }

  private open(call: TrackedCall): HarnessToolCall {
    if (call.shown !== null) {
      return call.shown;
    }
    this.flushText();
    const shown = harnessToolCall(call.state, this.options.mcpNames);
    call.shown = shown;
    this.emit({ type: "tool.started", toolCall: shown });
    return shown;
  }

  private complete(
    call: TrackedCall,
    ending: Parameters<typeof harnessToolResult>[2],
  ) {
    if (call.done) {
      return;
    }
    const shown = this.open(call);
    call.done = true;
    this.emit({
      type: "tool.completed",
      toolCall: shown,
      result: harnessToolResult(call.state, shown, ending),
    });
  }

  /** Every call the turn left open ends with it. */
  private closeCalls(ending: "interrupted" | "failed") {
    for (const call of this.calls.values()) {
      if (!call.done && (call.shown !== null || call.state.title !== "")) {
        this.complete(call, ending);
      }
    }
  }

  /** Each plan the agent reports is its own completed step. */
  private plan(items: readonly string[]) {
    this.flushText();
    this.planCount += 1;
    const toolCall = nativeToolCall(
      `${this.sessionId ?? "acp"}:plan:${String(this.planCount)}`,
      {
        name: HARNESS_TOOL_NAMES.nativeTool,
        input: { tool: PLAN_TOOL, detail: { kind: "plan", items } },
      },
    );
    this.emit({ type: "tool.started", toolCall });
    this.emit({
      type: "tool.completed",
      toolCall,
      result: {
        content: chatLocalRunToolResultContent({
          name: HARNESS_TOOL_NAMES.nativeTool,
          result: { status: "completed" },
        }),
        status: "succeeded",
      },
    });
  }

  private request(id: AcpRequestId, method: string, params: unknown) {
    const client = this.lifecycle.client;
    if (client === null) {
      return;
    }
    if (method !== ACP_AGENT_REQUESTS.requestPermission) {
      client.respondError(
        id,
        ACP_ERROR.methodNotFound,
        `stella does not answer ${method}.`,
      );
      return;
    }
    const parsed = v.safeParse(AcpRequestPermissionSchema, params);
    if (!parsed.success || parsed.output.sessionId !== this.sessionId) {
      client.respondError(
        id,
        ACP_ERROR.invalidParams,
        "stella cannot read this permission request.",
      );
      return;
    }
    const request = parsed.output;
    const tracked = this.calls.get(request.toolCall.toolCallId);
    const state = mergeToolCall(tracked?.state ?? null, request.toolCall);
    const call: TrackedCall = tracked ?? { state, shown: null, done: false };
    call.state = state;
    this.calls.set(state.id, call);
    const optionOf = (kind: string) =>
      request.options.find((option) => option.kind === kind)?.optionId ?? null;
    const answer = (outcome: AcpPermissionOutcome) => {
      client.respond(id, { outcome });
    };
    if (this.lifecycle.ended || this.lifecycle.interrupting) {
      answer({ outcome: "cancelled" });
      return;
    }
    const disposition = permissionDisposition({
      call: state,
      policy: this.options.policy,
      workspaceDir: this.options.workspaceDir,
      unreadablePaths: this.options.unreadablePaths,
    });
    if (disposition !== "ask") {
      const optionId =
        disposition === "allow"
          ? (optionOf("allow_once") ?? optionOf("allow_always"))
          : optionOf("reject_once");
      answer(
        optionId === null
          ? { outcome: "cancelled" }
          : { outcome: "selected", optionId },
      );
      return;
    }
    const options: HarnessApprovalOption[] = [];
    for (const option of request.options) {
      const decision = DECISION_OF_OPTION[option.kind];
      if (
        decision !== undefined &&
        !options.some((offered) => offered.decision === decision)
      ) {
        options.push({ id: option.optionId, decision });
      }
    }
    if (options.length === 0) {
      answer({ outcome: "cancelled" });
      return;
    }
    const shown = this.open(call);
    const requestId = `acp-permission-${String(this.nextPermission)}`;
    this.nextPermission += 1;
    this.permissions.set(requestId, {
      jsonRpcId: id,
      toolCallId: state.id,
      options,
    });
    this.emit({
      type: "approval.requested",
      request: {
        requestId,
        kind: approvalKindOf(state, shown),
        toolCall: shown,
        reason: null,
        options,
      },
    });
  }

  private respond(
    response: HarnessInteractionResponse,
  ): Result<void, HarnessRespondError> {
    if (this.lifecycle.ended) {
      return respondError("turn_ended", "The turn has already ended.");
    }
    const pending = this.permissions.get(response.requestId);
    if (pending === undefined) {
      return respondError("unknown_request", "No such request is pending.");
    }
    if (response.type !== "approval") {
      return respondError(
        "invalid_response",
        "A permission request takes an approval.",
      );
    }
    const option = pending.options.find(
      (offered) => offered.decision === response.decision,
    );
    if (option === undefined) {
      return respondError(
        "invalid_response",
        "The request did not offer this decision.",
      );
    }
    this.permissions.delete(response.requestId);
    this.lifecycle.client?.respond(pending.jsonRpcId, {
      outcome: { outcome: "selected", optionId: option.id },
    });
    this.emit({ type: "interaction.resolved", requestId: response.requestId });
    if (response.decision === "deny") {
      const call = this.calls.get(pending.toolCallId);
      if (call !== undefined) {
        this.complete(call, "declined");
      }
    }
    return Result.ok();
  }

  /** Every pending permission request is withdrawn, as ACP asks on cancel. */
  private cancelPermissions() {
    for (const [requestId, pending] of this.permissions) {
      this.lifecycle.client?.respond(pending.jsonRpcId, {
        outcome: { outcome: "cancelled" },
      });
      this.emit({ type: "interaction.resolved", requestId });
    }
    this.permissions.clear();
  }

  /** The turn's usage: every prompt's tokens, the last context reported. */
  private usage(): HarnessUsage | null {
    const context =
      this.context === null
        ? null
        : harnessContextUsage(this.context.used, this.context.size);
    if (this.promptUsage.length === 0 && context === null) {
      return null;
    }
    const sum = (field: keyof PromptUsage) =>
      this.promptUsage.reduce((total, usage) => total + (usage[field] ?? 0), 0);
    return {
      inputTokens: sum("inputTokens"),
      cachedInputTokens: sum("cachedReadTokens"),
      outputTokens: sum("outputTokens"),
      reasoningOutputTokens: sum("thoughtTokens"),
      context,
    };
  }

  private fail(failure: HarnessFailure) {
    this.flushText();
    this.closeCalls("failed");
    this.emit({ type: "turn.failed", failure });
  }

  private finish(answer: AcpAnswer) {
    if (this.lifecycle.ended) {
      return;
    }
    this.cancelPermissions();
    if (Result.isError(answer)) {
      const { error } = answer;
      if (error.reason !== "rejected") {
        // The process ended or stopped answering: its exit ends the turn.
        return;
      }
      if (this.lifecycle.interrupting) {
        this.flushText();
        this.closeCalls("interrupted");
        this.emit({ type: "turn.interrupted" });
        return;
      }
      this.options.onPromptError(error.message);
      this.fail(
        error.code === ACP_ERROR.authRequired
          ? {
              type: "auth_required",
              message: `${this.options.displayName} is not signed in.`,
            }
          : {
              type: "provider_error",
              message: error.message,
              code: String(error.code ?? "error"),
            },
      );
      return;
    }
    const parsed = v.safeParse(AcpPromptResponseSchema, answer.value);
    if (!parsed.success) {
      this.fail({
        type: "protocol_violation",
        message: "The agent answered the prompt with an unexpected shape.",
      });
      return;
    }
    const { stopReason } = parsed.output;
    if (stopReason === "cancelled" || this.lifecycle.interrupting) {
      this.flushText();
      this.closeCalls("interrupted");
      this.emit({ type: "turn.interrupted" });
      return;
    }
    const stopped = ACP_FAILURE_OF_STOP[stopReason];
    if (stopped !== undefined) {
      this.fail({ type: "provider_error", ...stopped });
      return;
    }
    this.flushText();
    this.closeCalls("interrupted");
    this.emit({
      type: "turn.completed",
      usage: this.usage(),
      boundary: null,
    });
  }
}
