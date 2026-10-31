import { panic, Result } from "better-result";
import type { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import {
  type HarnessInteractionResponse,
  HarnessRespondError,
  type HarnessTurn,
} from "../adapter";
import { createEventQueue } from "../event-queue";
import type {
  HarnessApprovalOption,
  HarnessContinuation,
  HarnessEvent,
  HarnessQuestion,
  HarnessSessionId,
  HarnessToolCall,
  HarnessUsage,
} from "../events";
import { unsupportedItem } from "../tool-parts";
import type {
  ClaudeCliClient,
  ClaudeCliExit,
  ClaudeCliHandlers,
  Detached,
} from "./cli-client";
import { blockingReset, classifyResultFailure } from "./errors";
import {
  approvalKindForTool,
  ASK_USER_QUESTION_TOOL,
  claudeMessageHandling,
  claudeSystemHandling,
  toolCallForUse,
  toolResultFor,
} from "./items";
import {
  ApiRetryMessageSchema,
  AskUserQuestionInputSchema,
  AssistantMessageSchema,
  CanUseToolRequestSchema,
  CLAUDE_CONTROL_REQUESTS,
  type ClaudeControlRequestSubtype,
  type ClaudeResultMessage,
  type ClaudeToolUse,
  ContentBlockSchema,
  isClaudeContentBlockType,
  isClaudeControlRequestSubtype,
  isClaudeMessageType,
  isClaudeSystemSubtype,
  RateLimitEventSchema,
  ResultMessageSchema,
  STREAM_EVENTS,
  StreamEventMessageSchema,
  SystemMessageSchema,
  ToolResultBlockSchema,
  UserMessageSchema,
} from "./protocol";

/**
 * One Claude Code turn: routes the CLI's stream-json messages and control
 * requests into harness events, and carries answers back over the live
 * control channel. The process hosts exactly this turn and is shut down when
 * it ends.
 *
 * Protocol traps handled here, adapted from t3code (MIT,
 * `ClaudeAdapterV2.ts`): the CLI writes one assistant message per completed
 * content block, so streamed text deltas are paired with the block they
 * belong to by message id and order; a question is the `AskUserQuestion`
 * tool's permission prompt, answered by allowing the call with the answers
 * in its input; a subagent's messages carry the tool call that started it
 * and are not this turn's output.
 */

/** Native permission replies, as the runner protocol's decisions. */
const CLAUDE_APPROVAL_OPTIONS = [
  { id: "allow", decision: "approve" },
  { id: "allowForSession", decision: "approve_for_session" },
  { id: "deny", decision: "deny" },
] as const satisfies readonly HarnessApprovalOption[];

/** Without suggested rules there is nothing to remember for the session. */
const ONE_OFF_OPTIONS = CLAUDE_APPROVAL_OPTIONS.filter(
  ({ decision }) => decision !== "approve_for_session",
);

/** What the model reads when the user denies a tool call. */
const DENIED_MESSAGE = "The user denied this action.";
/** Rules granted for the session stay in memory, never in a settings file. */
const SESSION_DESTINATION = "session";
const MAX_REASON_CHARS = 2000;
const ESCAPE = "\u001B";

const requestIdFor = (controlId: string) => `claude-request-${controlId}`;

type PendingInteraction =
  | {
      type: "approval";
      controlId: string;
      input: Readonly<Record<string, unknown>>;
      /** Permission rules the CLI suggests remembering, if approved. */
      suggestions: readonly Readonly<Record<string, unknown>>[];
    }
  | {
      type: "question";
      controlId: string;
      input: Readonly<Record<string, unknown>>;
      questions: readonly HarnessQuestion[];
      /** Question id to the question text the native answer is keyed by. */
      texts: ReadonlyMap<string, string>;
    };

type EarlyMessage =
  | { kind: "message"; type: string; raw: unknown }
  | {
      kind: "control";
      requestId: string;
      subtype: ClaudeControlRequestSubtype;
      request: unknown;
    }
  | { kind: "cancel"; requestId: string };

type HeldToolUse = {
  use: Pick<ClaudeToolUse, "name" | "input">;
  toolCall: HarnessToolCall;
};

/**
 * Terminal escape sequences dropped from a reason the CLI wrote for its own
 * terminal; the text is shown as plain text.
 */
const plainReason = (text: string) => {
  let plain = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== ESCAPE) {
      plain += text[index];
      continue;
    }
    // `ESC [ ... final`: skip to the final byte of the sequence.
    if (text[index + 1] === "[") {
      index += 2;
      while (index < text.length && !/[@-~]/u.test(text[index] ?? "")) {
        index += 1;
      }
    }
  }
  return plain.trim().slice(0, MAX_REASON_CHARS);
};

const usageOf = (result: ClaudeResultMessage): HarnessUsage | null => {
  const { usage } = result;
  if (usage === undefined) {
    return null;
  }
  // Anthropic reports cache reads and writes apart from `input_tokens`.
  const cached = usage.cache_read_input_tokens ?? 0;
  return {
    inputTokens:
      usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + cached,
    cachedInputTokens: cached,
    outputTokens: usage.output_tokens,
    // Thinking tokens are counted inside output tokens and not broken out.
    reasoningOutputTokens: 0,
  };
};

const settlesWithin = async (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);

const respondError = (reason: HarnessRespondError["reason"], message: string) =>
  Result.err(new HarnessRespondError({ reason, message }));

/** The `can_use_tool` reply for an answer, or why the answer does not fit. */
const interactionResult = (
  pending: PendingInteraction,
  response: HarnessInteractionResponse,
): Result<object, string> => {
  switch (pending.type) {
    case "approval":
      if (response.type !== "approval") {
        return Result.err("This request takes an approval decision.");
      }
      switch (response.decision) {
        case "approve":
          return Result.ok({ behavior: "allow", updatedInput: pending.input });
        case "approve_for_session":
          if (pending.suggestions.length === 0) {
            return Result.err("The harness does not offer this decision.");
          }
          return Result.ok({
            behavior: "allow",
            updatedInput: pending.input,
            updatedPermissions: pending.suggestions.map((suggestion) => ({
              ...suggestion,
              destination: SESSION_DESTINATION,
            })),
          });
        case "deny":
          return Result.ok({ behavior: "deny", message: DENIED_MESSAGE });
        default:
          response.decision satisfies never;
          return panic("Unhandled approval decision");
      }
    case "question": {
      if (response.type !== "answers") {
        return Result.err("This request takes answers.");
      }
      const answers: [string, string][] = [];
      for (const question of pending.questions) {
        const given = response.answers[question.id] ?? [];
        if (given.length === 0) {
          return Result.err(`Question ${question.id} has no answer.`);
        }
        const labels = new Set(question.options.map(({ label }) => label));
        if (!question.allowsFreeText && given.some((a) => !labels.has(a))) {
          return Result.err(
            `Question ${question.id} takes one of its options.`,
          );
        }
        // Native answers are keyed by the question text; several selected
        // options are one comma-separated answer.
        answers.push([pending.texts.get(question.id) ?? "", given.join(", ")]);
      }
      return Result.ok({
        behavior: "allow",
        updatedInput: {
          ...pending.input,
          answers: Object.fromEntries(answers),
        },
      });
    }
    default:
      pending satisfies never;
      return panic("Unhandled pending interaction");
  }
};

type ClaudeCodeTurnSessionOptions = {
  gracePeriodMs: number;
  detached: Detached;
  /** The server name the turn registered the stella MCP binding under. */
  stellaServer: string;
};

export class ClaudeCodeTurnSession {
  private readonly queue = createEventQueue<HarnessEvent>();
  private readonly terminal = Promise.withResolvers<undefined>();
  private readonly gracePeriodMs: number;
  private client: ClaudeCliClient | null = null;
  private began = false;
  private ended = false;
  private interrupting = false;
  private assistantError: string | null = null;
  private readonly rejectedResets: Temporal.Instant[] = [];
  private readonly early: EarlyMessage[] = [];
  private readonly toolUses = new Map<string, HeldToolUse>();
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly resolved = new Set<string>();
  /** Text block ids streamed per assistant message, in block order. */
  private readonly streamedTexts = new Map<string, string[]>();
  /** The streamed message's text block ids by content block index. */
  private readonly streamBlocks = new Map<number, string>();
  private streamMessageId: string | null = null;
  private textBlocks = 0;
  private reasoningBlocks = 0;
  private unsupportedItems = 0;

  private readonly detached: Detached;
  private readonly stellaServer: string;

  constructor({
    gracePeriodMs,
    detached,
    stellaServer,
  }: ClaudeCodeTurnSessionOptions) {
    this.gracePeriodMs = gracePeriodMs;
    this.detached = detached;
    this.stellaServer = stellaServer;
  }

  /** Handlers for the process; messages before `begin` are held. */
  readonly handlers: ClaudeCliHandlers = {
    message: (type, raw) => {
      if (!this.began) {
        this.early.push({ kind: "message", type, raw });
        return;
      }
      this.message(type, raw);
    },
    controlRequest: (requestId, subtype, request) => {
      if (!isClaudeControlRequestSubtype(subtype)) {
        this.client?.respondError(
          requestId,
          `Stella does not answer ${subtype}.`,
        );
        return;
      }
      if (!this.began) {
        this.early.push({ kind: "control", requestId, subtype, request });
        return;
      }
      this.controlRequest(requestId, subtype, request);
    },
    controlCancel: (requestId) => {
      if (!this.began) {
        this.early.push({ kind: "cancel", requestId });
        return;
      }
      this.controlCancel(requestId);
    },
    violation: (message) => {
      this.violation(message);
    },
    exit: (exit) => {
      this.exited(exit);
    },
  };

  attach(client: ClaudeCliClient) {
    this.client = client;
  }

  /** The session is open: announce it and release held messages. */
  begin(options: {
    sessionId: HarnessSessionId;
    continuation: HarnessContinuation;
  }) {
    this.emit({
      type: "session.started",
      sessionId: options.sessionId,
      continuation: options.continuation,
    });
    this.began = true;
    for (const message of this.early.splice(0)) {
      switch (message.kind) {
        case "message":
          this.message(message.type, message.raw);
          break;
        case "control":
          this.controlRequest(
            message.requestId,
            message.subtype,
            message.request,
          );
          break;
        case "cancel":
          this.controlCancel(message.requestId);
          break;
        default:
          message satisfies never;
          panic("Unhandled held Claude message");
      }
    }
  }

  /** The turn never started; nothing more is emitted. */
  abandon() {
    this.ended = true;
    this.queue.close();
  }

  turn(): HarnessTurn {
    return {
      events: this.queue.items,
      respond: async (response) =>
        await Promise.resolve(this.respond(response)),
      interrupt: async () => this.interrupt(),
      dispose: async () => this.dispose(),
    };
  }

  private emit(event: HarnessEvent) {
    if (this.ended) {
      return;
    }
    this.queue.push(event);
    if (
      event.type === "turn.completed" ||
      event.type === "turn.interrupted" ||
      event.type === "turn.failed"
    ) {
      this.ended = true;
      this.queue.close();
      this.terminal.resolve(undefined);
      this.detached(this.shutdown(), "claude-turn.shutdown");
    }
  }

  private violation(message: string) {
    this.emit({
      type: "turn.failed",
      failure: { type: "protocol_violation", message },
    });
  }

  private exited({ exitCode, signal }: ClaudeCliExit) {
    if (this.interrupting) {
      this.emit({ type: "turn.interrupted" });
      return;
    }
    this.emit({
      type: "turn.failed",
      failure: {
        type: "harness_exited",
        message: "The harness stopped before the turn finished.",
        exitCode,
        signal,
      },
    });
  }

  /** Ask the process to exit cleanly so its session is saved, then kill it. */
  private async shutdown() {
    const client = this.client;
    if (client === null) {
      return;
    }
    client.closeInput();
    if (!(await settlesWithin(client.exited, this.gracePeriodMs))) {
      await client.kill();
    }
  }

  private parse<TSchema extends v.GenericSchema>(
    schema: TSchema,
    raw: unknown,
    what: string,
  ): v.InferOutput<TSchema> | null {
    const parsed = v.safeParse(schema, raw);
    if (!parsed.success) {
      this.violation(`The harness sent a malformed ${what}.`);
      return null;
    }
    return parsed.output;
  }

  /**
   * Something the pinned protocol does not define, shown as a failed
   * activity so the turn visibly did something Stella skipped.
   */
  private unsupported(kind: string) {
    this.unsupportedItems += 1;
    this.emit({
      type: "tool.completed",
      ...unsupportedItem(
        `claude-unsupported-${String(this.unsupportedItems)}`,
        kind,
      ),
    });
  }

  private message(type: string, raw: unknown) {
    if (!isClaudeMessageType(type)) {
      this.unsupported(type);
      return;
    }
    const handling = claudeMessageHandling(type);
    switch (handling) {
      case "assistant":
        this.assistant(
          this.parse(AssistantMessageSchema, raw, "assistant message"),
        );
        return;
      case "user":
        this.user(this.parse(UserMessageSchema, raw, "user message"));
        return;
      case "result":
        this.result(this.parse(ResultMessageSchema, raw, "result"));
        return;
      case "system":
        this.system(raw);
        return;
      case "stream":
        this.stream(this.parse(StreamEventMessageSchema, raw, "stream event"));
        return;
      case "rate_limit": {
        const parsed = this.parse(RateLimitEventSchema, raw, "rate limit");
        const reset =
          parsed === null ? null : blockingReset(parsed.rate_limit_info);
        if (reset !== null) {
          this.rejectedResets.push(reset);
        }
        return;
      }
      case "ignore":
        return;
      default:
        handling satisfies never;
        panic("Unhandled Claude message handling");
    }
  }

  private system(raw: unknown) {
    const parsed = this.parse(SystemMessageSchema, raw, "system message");
    if (parsed === null) {
      return;
    }
    if (!isClaudeSystemSubtype(parsed.subtype)) {
      this.unsupported(`system:${parsed.subtype}`);
      return;
    }
    const handling = claudeSystemHandling(parsed.subtype);
    switch (handling) {
      case "retrying": {
        const retry = this.parse(ApiRetryMessageSchema, raw, "retry notice");
        if (retry !== null) {
          this.emit({
            type: "retrying",
            message: `Retrying after ${retry.error} (attempt ${String(retry.attempt)} of ${String(retry.max_retries)}).`,
          });
        }
        return;
      }
      case "ignore":
        return;
      default:
        handling satisfies never;
        panic("Unhandled Claude system handling");
    }
  }

  /**
   * Raw stream events, read only for the main thread's text as it is
   * written; every other event repeats what the completed messages report.
   */
  private stream(
    parsed: v.InferOutput<typeof StreamEventMessageSchema> | null,
  ) {
    if (parsed === null || (parsed.parent_tool_use_id ?? null) !== null) {
      return;
    }
    const { event } = parsed;
    switch (event.type) {
      case "message_start": {
        const start = this.parse(STREAM_EVENTS.message_start, event, "stream");
        if (start !== null) {
          this.streamMessageId = start.message.id;
          this.streamBlocks.clear();
        }
        return;
      }
      case "content_block_start": {
        const start = this.parse(
          STREAM_EVENTS.content_block_start,
          event,
          "stream",
        );
        const messageId = this.streamMessageId;
        if (
          start === null ||
          messageId === null ||
          start.content_block.type !== "text"
        ) {
          return;
        }
        const blockId = `${messageId}:${String(start.index)}`;
        this.streamBlocks.set(start.index, blockId);
        const streamed = this.streamedTexts.get(messageId) ?? [];
        streamed.push(blockId);
        this.streamedTexts.set(messageId, streamed);
        return;
      }
      case "content_block_delta": {
        const delta = this.parse(
          STREAM_EVENTS.content_block_delta,
          event,
          "stream",
        );
        const blockId =
          delta === null ? undefined : this.streamBlocks.get(delta.index);
        if (
          delta === null ||
          blockId === undefined ||
          delta.delta.type !== "text_delta" ||
          delta.delta.text === undefined
        ) {
          return;
        }
        this.emit({
          type: "text.delta",
          messageId: blockId,
          delta: delta.delta.text,
        });
        return;
      }
      default:
        return;
    }
  }

  /** The id a completed text block was streamed under, else a new one. */
  private textIdFor(messageId: string) {
    const streamed = this.streamedTexts.get(messageId)?.shift();
    if (streamed !== undefined) {
      return streamed;
    }
    this.textBlocks += 1;
    return `${messageId}:text-${String(this.textBlocks)}`;
  }

  private assistant(
    parsed: v.InferOutput<typeof AssistantMessageSchema> | null,
  ) {
    if (parsed === null || (parsed.parent_tool_use_id ?? null) !== null) {
      return;
    }
    if (parsed.error !== undefined) {
      // The CLI's own text for an API failure; the result reports it typed.
      this.assistantError = parsed.error;
      return;
    }
    const messageId = parsed.message.id;
    for (const raw of parsed.message.content) {
      if (!isClaudeContentBlockType(raw.type)) {
        this.unsupported(raw.type);
        continue;
      }
      const block = this.parse(ContentBlockSchema, raw, "content block");
      if (block === null) {
        return;
      }
      switch (block.type) {
        case "text":
          this.emit({
            type: "text.completed",
            messageId: this.textIdFor(messageId),
            text: block.text,
          });
          break;
        case "thinking": {
          const text = block.thinking.trim();
          if (text !== "") {
            this.reasoningBlocks += 1;
            this.emit({
              type: "reasoning.completed",
              messageId: `${messageId}:thinking-${String(this.reasoningBlocks)}`,
              text,
            });
          }
          break;
        }
        case "tool_use": {
          const toolCall = toolCallForUse(block, this.stellaServer);
          this.toolUses.set(block.id, { use: block, toolCall });
          this.emit({ type: "tool.started", toolCall });
          break;
        }
        case "redacted_thinking":
          // Encrypted reasoning carries no text to show.
          break;
        default:
          block satisfies never;
          panic("Unhandled Claude content block");
      }
    }
  }

  private user(parsed: v.InferOutput<typeof UserMessageSchema> | null) {
    if (
      parsed === null ||
      (parsed.parent_tool_use_id ?? null) !== null ||
      typeof parsed.message.content === "string"
    ) {
      return;
    }
    // Text blocks here are the CLI's own notes to the model; only tool
    // results are output.
    for (const raw of parsed.message.content) {
      if (raw.type !== "tool_result") {
        continue;
      }
      const block = this.parse(ToolResultBlockSchema, raw, "tool result");
      if (block === null) {
        return;
      }
      const held = this.toolUses.get(block.tool_use_id);
      // A result always follows its call on the main thread.
      if (held !== undefined) {
        this.emit({
          type: "tool.completed",
          toolCall: held.toolCall,
          result: toolResultFor(held.use, block),
        });
      }
    }
  }

  private result(parsed: ClaudeResultMessage | null) {
    if (parsed === null) {
      return;
    }
    // Whatever the CLI reports after an interrupt, the user stopped the turn.
    if (this.interrupting) {
      this.emit({ type: "turn.interrupted" });
      return;
    }
    if (parsed.subtype === "success" && !parsed.is_error) {
      this.emit({ type: "turn.completed", usage: usageOf(parsed) });
      return;
    }
    this.emit({
      type: "turn.failed",
      failure: classifyResultFailure({
        result: parsed,
        assistantError: this.assistantError,
        rejectedResets: this.rejectedResets,
      }),
    });
  }

  private controlRequest(
    requestId: string,
    subtype: ClaudeControlRequestSubtype,
    request: unknown,
  ) {
    switch (subtype) {
      case "can_use_tool":
        this.permission(requestId, request);
        return;
      case "elicitation":
        this.client?.respond(
          requestId,
          CLAUDE_CONTROL_REQUESTS[subtype].response,
        );
        return;
      case "hook_callback":
      case "mcp_message":
      case "request_user_dialog":
        this.client?.respondError(
          requestId,
          `Stella does not answer ${subtype}.`,
        );
        return;
      default:
        subtype satisfies never;
        panic("Unhandled Claude control request");
    }
  }

  private permission(controlId: string, request: unknown) {
    const parsed = this.parse(
      CanUseToolRequestSchema,
      request,
      "permission request",
    );
    if (parsed === null) {
      return;
    }
    const requestId = requestIdFor(controlId);
    const use = { name: parsed.tool_name, input: parsed.input };
    const held = this.toolUses.get(parsed.tool_use_id);
    const toolCall =
      held?.toolCall ??
      toolCallForUse({ id: parsed.tool_use_id, ...use }, this.stellaServer);
    this.toolUses.set(parsed.tool_use_id, held ?? { use, toolCall });
    if (parsed.tool_name === ASK_USER_QUESTION_TOOL) {
      this.question(controlId, toolCall, parsed.input);
      return;
    }
    const suggestions = parsed.permission_suggestions ?? [];
    this.pending.set(requestId, {
      type: "approval",
      controlId,
      input: parsed.input,
      suggestions,
    });
    const reason =
      parsed.decision_reason ?? parsed.description ?? parsed.title ?? null;
    this.emit({
      type: "approval.requested",
      request: {
        requestId,
        kind: approvalKindForTool(parsed.tool_name),
        toolCall,
        reason: reason === null ? null : plainReason(reason),
        options:
          suggestions.length > 0 ? CLAUDE_APPROVAL_OPTIONS : ONE_OFF_OPTIONS,
      },
    });
  }

  private question(
    controlId: string,
    toolCall: HarnessToolCall,
    input: Readonly<Record<string, unknown>>,
  ) {
    const parsed = this.parse(AskUserQuestionInputSchema, input, "question");
    if (parsed === null) {
      return;
    }
    const requestId = requestIdFor(controlId);
    const texts = new Map<string, string>();
    const questions = parsed.questions.map((question, index) => {
      const id = String(index);
      texts.set(id, question.question);
      return {
        id,
        header: question.header,
        prompt: question.question,
        options: question.options,
        // The harness always lets the user write their own answer.
        allowsFreeText: true,
        secret: false,
      };
    });
    this.pending.set(requestId, {
      type: "question",
      controlId,
      input,
      questions,
      texts,
    });
    this.emit({
      type: "question.requested",
      request: { requestId, answerWith: "response", questions, toolCall },
    });
  }

  /** Withdrawn by the harness, typically because the turn is stopping. */
  private controlCancel(controlId: string) {
    const requestId = requestIdFor(controlId);
    if (this.pending.has(requestId)) {
      this.settle(requestId);
    }
  }

  private settle(requestId: string) {
    this.pending.delete(requestId);
    this.resolved.add(requestId);
    this.emit({ type: "interaction.resolved", requestId });
  }

  private respond(
    response: HarnessInteractionResponse,
  ): Result<void, HarnessRespondError> {
    const { requestId } = response;
    if (this.resolved.has(requestId)) {
      return respondError(
        "already_resolved",
        "This request was already resolved.",
      );
    }
    const interaction = this.pending.get(requestId);
    if (interaction === undefined) {
      return respondError("unknown_request", "No pending request has this id.");
    }
    if (this.ended || this.client === null) {
      return respondError("turn_ended", "The turn has already ended.");
    }
    const result = interactionResult(interaction, response);
    if (Result.isError(result)) {
      return respondError("invalid_response", result.error);
    }
    // The call's own result follows from the harness once it has run.
    this.client.respond(interaction.controlId, result.value);
    this.settle(requestId);
    return Result.ok();
  }

  private async interrupt() {
    const client = this.client;
    if (this.ended || this.interrupting || client === null) {
      return;
    }
    this.interrupting = true;
    await settlesWithin(client.request("interrupt"), this.gracePeriodMs);
    if (!(await settlesWithin(this.terminal.promise, this.gracePeriodMs))) {
      // The harness did not confirm; the shutdown that follows kills it.
      this.emit({ type: "turn.interrupted" });
    }
  }

  private async dispose() {
    if (!this.ended) {
      this.interrupting = true;
      this.emit({ type: "turn.interrupted" });
    }
    await this.shutdown();
  }
}
