import { panic, Result } from "better-result";
import type { Temporal } from "temporal-polyfill/full";
import * as v from "valibot";

import { CHAT_LOCAL_RUN_TOOL_LIMITS } from "@stll/api-contract/chat-local-run-tool";
import {
  chatLocalRunAnswersRefusal,
  chatLocalRunQuestionsSchema,
} from "@stll/api-contract/chat-run-target";
import { requestedNetworkHost } from "@stll/skills/network-hosts";

import type {
  HarnessInteractionResponse,
  HarnessRespondError,
  HarnessSteerInput,
  HarnessTurn,
} from "../adapter";
import {
  type HarnessApprovalOption,
  harnessContextUsage,
  type HarnessContinuation,
  type HarnessEvent,
  type HarnessQuestion,
  type HarnessSessionId,
  type HarnessToolCall,
  type HarnessToolResult,
  type HarnessUsage,
} from "../events";
import { SubagentConversation } from "../step-output";
import { stepOfSubagent, unsupportedItem } from "../tool-parts";
import {
  type Detached,
  type HarnessTurnBackground,
  HarnessTurnLifecycle,
  respondError,
  settlesWithin,
} from "../turn-lifecycle";
import type { ClaudeCliClient, ClaudeCliHandlers } from "./cli-client";
import { blockingReset, classifyResultFailure } from "./errors";
import {
  approvalKindForTool,
  ASK_USER_QUESTION_TOOL,
  claudeMessageHandling,
  claudeSystemHandling,
  EXIT_PLAN_MODE_TOOL,
  resultText,
  startsSubagent,
  subagentPromptOf,
  toolCallForUse,
  toolResultFor,
} from "./items";
import {
  ApiRetryMessageSchema,
  AskUserQuestionInputSchema,
  AssistantMessageSchema,
  CanUseToolRequestSchema,
  CLAUDE_CONTROL_REQUESTS,
  CLAUDE_STOPPED_TOOL_KINDS,
  type ClaudeControlRequestSubtype,
  type ClaudeResultMessage,
  type ClaudeToolResult,
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
 * in its input; a proposed plan is the `ExitPlanMode` tool's permission
 * prompt, whose input the CLI fills with the plan; a subagent's messages
 * carry the tool call that started it, and of them only its tool calls are
 * this turn's output, as steps of that call.
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

/**
 * A suggested rule of this type would change the turn's permission mode; the
 * mode is the member's choice for the thread, so it is never offered.
 */
const SET_MODE_SUGGESTION = "setMode";

/** What the model reads when the user denies a tool call. */
const DENIED_MESSAGE = "The user denied this action.";
/** Chat shows a proposed plan up to this length; a longer one is never put
 *  to the member, since approving it would approve steps they cannot see. */
const MAX_PLAN_CHARS = CHAT_LOCAL_RUN_TOOL_LIMITS.proposedPlan;
const PLAN_MISSING_MESSAGE =
  "No plan was given for the user to review: propose the plan's text.";
const PLAN_TOO_LONG_MESSAGE = `The plan is too long for the user to review: keep it under ${MAX_PLAN_CHARS} characters and propose it again.`;
/** Rules granted for the session stay in memory, never in a settings file. */
const SESSION_DESTINATION = "session";
const MAX_REASON_CHARS = 2000;
const ESCAPE = "\u001B";

const requestIdFor = (controlId: string) => `claude-request-${controlId}`;

const SubagentMessageSchema = v.looseObject({
  parent_tool_use_id: v.pipe(v.string(), v.nonEmpty()),
});

/**
 * The call that started the subagent a message belongs to, read before the
 * message's own schema, or `null` for a message of the main thread.
 */
const subagentCallOf = (raw: unknown): string | null => {
  const parsed = v.safeParse(SubagentMessageSchema, raw);
  return parsed.success ? parsed.output.parent_tool_use_id : null;
};

type PendingInteraction =
  | {
      type: "approval";
      controlId: string;
      input: Readonly<Record<string, unknown>>;
      /** Permission rules the CLI suggests remembering, if approved. */
      suggestions: readonly Readonly<Record<string, unknown>>[];
      /**
       * The main thread's `ExitPlanMode` call this approval answers, else
       * `null`. A subagent's plan is its own: approving it does not take the
       * turn out of plan mode.
       */
      planToolUseId: string | null;
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
  /** The call that started the subagent this call belongs to, else `null`. */
  parentCallId: string | null;
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

type ClaudeMessageUsage = NonNullable<ClaudeResultMessage["usage"]>;

/** The main thread's last model request: the model and what it held. */
type LastRequest = { model: string | null; contextTokens: number };

/** Anthropic reports cache reads and writes apart from `input_tokens`. */
const inputTokensOf = (usage: ClaudeMessageUsage) =>
  usage.input_tokens +
  (usage.cache_creation_input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0);

/**
 * The context window of the model that made the last request. A result that
 * names one model only is that model's, whatever the request called it.
 */
const contextWindowOf = (
  result: ClaudeResultMessage,
  model: string | null,
): number | undefined => {
  const models = Object.entries(result.modelUsage ?? {});
  const named =
    model === null
      ? undefined
      : models.find(([name]) => name === model)?.[1].contextWindow;
  if (named !== undefined) {
    return named;
  }
  const [only] = models;
  return models.length === 1 ? only?.[1].contextWindow : undefined;
};

const usageOf = (
  result: ClaudeResultMessage,
  lastRequest: LastRequest | null,
): HarnessUsage | null => {
  const { usage } = result;
  if (usage === undefined) {
    return null;
  }
  return {
    inputTokens: inputTokensOf(usage),
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens,
    // Thinking tokens are counted inside output tokens and not broken out.
    reasoningOutputTokens: 0,
    context:
      lastRequest === null
        ? null
        : harnessContextUsage(
            lastRequest.contextTokens,
            contextWindowOf(result, lastRequest.model),
          ),
  };
};

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
      const refusal = chatLocalRunAnswersRefusal(
        pending.questions,
        response.answers,
      );
      if (refusal !== null) {
        return Result.err(refusal);
      }
      const answers: [string, string][] = [];
      for (const question of pending.questions) {
        const given = response.answers[question.id] ?? [];
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
  /**
   * The hosts a sandboxed command may reach without the member being asked:
   * those the turn's skills declare. The CLI's sandbox routes commands
   * through a proxy that asks about every new host; a host not here is asked
   * about like any other action.
   */
  sandboxNetworkHosts: ReadonlySet<string>;
  /**
   * The CLI mode a turn started in plan mode switches to once the member
   * approves its plan; `null` for a turn at any other level, where an
   * approved plan returns the CLI to the mode it planned from.
   */
  approvedPlanMode: string | null;
  /** The process's background work at the turn's end. */
  background: HarnessTurnBackground<ClaudeCliClient>;
};

/**
 * The tool name the CLI asks with when a sandboxed command reaches a host its
 * sandbox has not allowed yet. Not a model tool: no tool call carries it.
 */
const SANDBOX_NETWORK_TOOL = "SandboxNetworkAccess";

export class ClaudeCodeTurnSession {
  private began = false;
  /** The session the turn's messages are written to, once it is open. */
  private sessionId: HarnessSessionId | null = null;
  /** Steering messages written and not echoed yet: uuid to input id. */
  private readonly steering = new Map<string, string>();
  private assistantError: string | null = null;
  /** The main thread's last model request, for the context it held. */
  private lastRequest: LastRequest | null = null;
  private readonly rejectedResets: Temporal.Instant[] = [];
  private readonly early: EarlyMessage[] = [];
  private readonly toolUses = new Map<string, HeldToolUse>();
  /**
   * What each subagent at work has written, by the call that started it,
   * held until that call's result ends the subagent. It never leaves this
   * computer: the call's result keeps it for the member to open here.
   */
  private readonly conversations = new Map<string, SubagentConversation>();
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly resolved = new Set<string>();
  /** Approved `ExitPlanMode` calls whose result has not arrived yet. */
  private readonly approvedPlans = new Set<string>();
  /** Text block ids streamed per assistant message, in block order. */
  private readonly streamedTexts = new Map<string, string[]>();
  /** The streamed message's text block ids by content block index. */
  private readonly streamBlocks = new Map<number, string>();
  private streamMessageId: string | null = null;
  private textBlocks = 0;
  private reasoningBlocks = 0;
  private unsupportedItems = 0;

  private readonly lifecycle: HarnessTurnLifecycle<ClaudeCliClient>;
  private readonly stellaServer: string;
  private readonly sandboxNetworkHosts: ReadonlySet<string>;
  private readonly approvedPlanMode: string | null;
  private readonly detached: Detached;

  constructor({
    gracePeriodMs,
    detached,
    stellaServer,
    sandboxNetworkHosts,
    approvedPlanMode,
    background,
  }: ClaudeCodeTurnSessionOptions) {
    this.lifecycle = new HarnessTurnLifecycle({
      gracePeriodMs,
      detached,
      name: "claude-turn",
      background,
    });
    this.stellaServer = stellaServer;
    this.sandboxNetworkHosts = sandboxNetworkHosts;
    this.approvedPlanMode = approvedPlanMode;
    this.detached = detached;
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
      this.lifecycle.exited(exit);
    },
  };

  attach(client: ClaudeCliClient) {
    this.lifecycle.attach(client);
  }

  private get client(): ClaudeCliClient | null {
    return this.lifecycle.client;
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
    this.sessionId = options.sessionId;
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
    this.lifecycle.abandon();
  }

  turn(): HarnessTurn {
    return this.lifecycle.turn({
      respond: (response) => this.respond(response),
      steer: (input) => {
        this.steer(input);
      },
      interrupt: async () => this.interrupt(),
    });
  }

  /**
   * Write the message to the CLI while the turn runs. The CLI queues it and
   * joins it to the turn at its next step, echoing it back with its uuid
   * then; a turn whose result arrives first never took it, and the
   * lifecycle settles it `rejected` with that result.
   */
  private steer({ inputId, text }: HarnessSteerInput) {
    const client = this.client;
    if (client === null || this.sessionId === null) {
      this.lifecycle.settleInput(inputId, "rejected");
      return;
    }
    const uuid = crypto.randomUUID();
    this.steering.set(uuid, inputId);
    client.send({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid,
    });
  }

  private emit(event: HarnessEvent) {
    this.lifecycle.emit(event);
  }

  private violation(message: string) {
    this.lifecycle.violation(message);
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
  private unsupported(kind: string, parentCallId: string | null = null) {
    this.unsupportedItems += 1;
    const { toolCall, result } = unsupportedItem(
      `claude-unsupported-${String(this.unsupportedItems)}`,
      kind,
    );
    this.emit({
      type: "tool.completed",
      toolCall: stepOfSubagent(toolCall, parentCallId),
      result,
    });
  }

  private message(type: string, raw: unknown) {
    if (!isClaudeMessageType(type)) {
      this.unsupported(type);
      return;
    }
    const handling = claudeMessageHandling(type);
    const parentCallId = subagentCallOf(raw);
    if (
      parentCallId !== null &&
      (handling === "assistant" || handling === "user" || handling === "stream")
    ) {
      this.subagentMessage(handling, raw, parentCallId);
      return;
    }
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
    if (parsed === null) {
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
    if (parsed === null) {
      return;
    }
    if (parsed.error !== undefined) {
      // The CLI's own text for an API failure; the result reports it typed.
      this.assistantError = parsed.error;
      return;
    }
    const { usage } = parsed.message;
    if (usage !== undefined) {
      // The next request carries this one's prompt and answer.
      this.lastRequest = {
        model: parsed.message.model ?? null,
        contextTokens: inputTokensOf(usage) + usage.output_tokens,
      };
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
        case "tool_use":
          this.toolUse(block, null);
          break;
        case "redacted_thinking":
          // Encrypted reasoning carries no text to show.
          break;
        default:
          block satisfies never;
          panic("Unhandled Claude content block");
      }
    }
  }

  private toolUse(block: ClaudeToolUse, parentCallId: string | null) {
    const toolCall = toolCallForUse(block, this.stellaServer, parentCallId);
    this.toolUses.set(block.id, { use: block, toolCall, parentCallId });
    if (startsSubagent(block)) {
      this.conversations.set(block.id, new SubagentConversation());
    }
    // A proposed plan opens with its approval: the CLI adds the plan
    // to the call's input only when it asks about the call.
    if (block.name !== EXIT_PLAN_MODE_TOOL) {
      this.emit({ type: "tool.started", toolCall });
    }
  }

  /**
   * A subagent's message: its tool calls and their results are steps of the
   * call that started it. What it wrote is held for that call's result to
   * keep on this computer, with what it was told and the report the call
   * returns; none of it is the turn's, and what it thought is not read.
   *
   * These steps only add to what chat shows, so a message or block of a
   * subagent that does not have its shape is never a protocol violation: it
   * becomes an unsupported step of the subagent, and the turn goes on.
   */
  private subagentMessage(
    handling: "assistant" | "user" | "stream",
    raw: unknown,
    parentCallId: string,
  ) {
    switch (handling) {
      case "stream":
        // A subagent's text as it is written.
        return;
      case "assistant": {
        const parsed = this.readOfSubagent(AssistantMessageSchema, raw, {
          kind: "assistant",
          parentCallId,
        });
        if (parsed === null) {
          return;
        }
        for (const block of parsed.message.content) {
          if (block.type === "text") {
            // A text block that does not have its shape is left out of the
            // kept conversation; it is no step, so nothing is shown for it.
            const written = v.safeParse(ContentBlockSchema, block);
            if (written.success && written.output.type === "text") {
              this.conversations.get(parentCallId)?.add(written.output.text);
            }
            continue;
          }
          if (block.type !== "tool_use") {
            continue;
          }
          const use = this.readOfSubagent(ContentBlockSchema, block, {
            kind: block.type,
            parentCallId,
          });
          if (use?.type === "tool_use") {
            this.toolUse(use, parentCallId);
          }
        }
        return;
      }
      case "user": {
        const parsed = this.readOfSubagent(UserMessageSchema, raw, {
          kind: "user",
          parentCallId,
        });
        if (parsed !== null) {
          this.user(parsed, parentCallId);
        }
        return;
      }
      default:
        handling satisfies never;
        panic("Unhandled Claude subagent message");
    }
  }

  /**
   * What a subagent sent, or `null` when it does not have `schema`'s shape,
   * which is then shown as an unsupported step of the subagent.
   */
  private readOfSubagent<TSchema extends v.GenericSchema>(
    schema: TSchema,
    raw: unknown,
    { kind, parentCallId }: { kind: string; parentCallId: string },
  ): v.InferOutput<TSchema> | null {
    const parsed = v.safeParse(schema, raw);
    if (parsed.success) {
      return parsed.output;
    }
    this.unsupported(kind, parentCallId);
    return null;
  }

  /**
   * A message's tool results. `parentCallId` is the call that started the
   * subagent whose message this is, or `null` on the main thread.
   */
  private user(
    parsed: v.InferOutput<typeof UserMessageSchema> | null,
    parentCallId: string | null = null,
  ) {
    if (parsed?.isReplay === true) {
      // The echo of a message written to stdin: a steer the turn took now,
      // or the turn's own prompt. Neither is output.
      const inputId =
        parsed.uuid === undefined ? undefined : this.steering.get(parsed.uuid);
      if (parsed.uuid !== undefined && inputId !== undefined) {
        this.steering.delete(parsed.uuid);
        this.lifecycle.settleInput(inputId, "accepted");
      }
      return;
    }
    if (parsed === null || typeof parsed.message.content === "string") {
      return;
    }
    // Text blocks here are the CLI's own notes to the model, or the prompt a
    // subagent was started with; only tool results are output.
    for (const raw of parsed.message.content) {
      if (raw.type !== "tool_result") {
        continue;
      }
      const block =
        parentCallId === null
          ? this.parse(ToolResultBlockSchema, raw, "tool result")
          : this.readOfSubagent(ToolResultBlockSchema, raw, {
              kind: raw.type,
              parentCallId,
            });
      if (block === null) {
        if (parentCallId === null) {
          return;
        }
        continue;
      }
      const held = this.toolUses.get(block.tool_use_id);
      const notRun = parsed.tool_result_meta?.find(
        ({ id }) => id === block.tool_use_id,
      )?.non_execution_kind;
      // A call the stop cut off never ran: not a failure, and not done.
      const stopped =
        notRun !== undefined &&
        notRun !== null &&
        CLAUDE_STOPPED_TOOL_KINDS.has(notRun);
      // A result always follows its call on its own thread, once: the call
      // is released with it.
      if (held !== undefined) {
        this.toolUses.delete(block.tool_use_id);
        const result = this.withConversation(
          block,
          held,
          toolResultFor(held.use, block),
        );
        this.emit({
          type: "tool.completed",
          toolCall: held.toolCall,
          result: stopped ? { ...result, status: "cancelled" } : result,
        });
      }
      // Only a plan call that ran leaves plan mode.
      if (this.approvedPlans.delete(block.tool_use_id)) {
        this.leavePlanMode(block.is_error === true || stopped);
      }
    }
  }

  /**
   * `result` with the conversation of the subagent `held` started, for the
   * sidecar to keep on this computer: what it was told, what it wrote, and
   * the report this result returns. Any other call's result is unchanged.
   */
  private withConversation(
    block: ClaudeToolResult,
    held: HeldToolUse,
    result: HarnessToolResult,
  ): HarnessToolResult {
    const conversation = this.conversations.get(block.tool_use_id);
    if (conversation === undefined) {
      return result;
    }
    this.conversations.delete(block.tool_use_id);
    return {
      ...result,
      localOutput: conversation.ended({
        prompt: subagentPromptOf(held.use),
        report: resultText(block),
      }),
    };
  }

  private result(parsed: ClaudeResultMessage | null) {
    if (parsed === null) {
      return;
    }
    // Whatever the CLI reports after an interrupt, the user stopped the turn.
    if (this.lifecycle.interrupting) {
      this.emit({ type: "turn.interrupted" });
      return;
    }
    if (parsed.subtype === "success" && !parsed.is_error) {
      this.emit({
        type: "turn.completed",
        usage: usageOf(parsed, this.lastRequest),
      });
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

  /** Whether a sandbox network request names a host the skills declare. */
  private isDeclaredHost(input: Readonly<Record<string, unknown>>): boolean {
    const requested = input["host"];
    const host =
      typeof requested === "string" ? requestedNetworkHost(requested) : null;
    return host !== null && this.sandboxNetworkHosts.has(host);
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
    if (
      parsed.tool_name === SANDBOX_NETWORK_TOOL &&
      this.isDeclaredHost(parsed.input)
    ) {
      this.client?.respond(controlId, {
        behavior: "allow",
        updatedInput: parsed.input,
      });
      return;
    }
    const requestId = requestIdFor(controlId);
    const use = { name: parsed.tool_name, input: parsed.input };
    const held = this.toolUses.get(parsed.tool_use_id);
    const proposesPlan = parsed.tool_name === EXIT_PLAN_MODE_TOOL;
    // A proposed plan's call is built from this input, which carries the
    // plan the member approves.
    const parentCallId = held?.parentCallId ?? null;
    const toolCall =
      held === undefined || proposesPlan
        ? toolCallForUse(
            { id: parsed.tool_use_id, ...use },
            this.stellaServer,
            parentCallId,
          )
        : held.toolCall;
    this.toolUses.set(parsed.tool_use_id, {
      use: held?.use ?? use,
      toolCall,
      parentCallId,
    });
    if (parsed.tool_name === ASK_USER_QUESTION_TOOL) {
      this.question(controlId, toolCall, parsed.input);
      return;
    }
    const plan = parsed.input["plan"];
    // A plan is put to the member only as the text they approve: none, or
    // more than chat shows, is refused before any approval opens.
    if (proposesPlan && (typeof plan !== "string" || plan.trim() === "")) {
      this.client?.respond(controlId, {
        behavior: "deny",
        message: PLAN_MISSING_MESSAGE,
      });
      return;
    }
    if (
      proposesPlan &&
      typeof plan === "string" &&
      plan.length > MAX_PLAN_CHARS
    ) {
      this.client?.respond(controlId, {
        behavior: "deny",
        message: PLAN_TOO_LONG_MESSAGE,
      });
      return;
    }
    // A plan is approved once: no rule from it outlives this call.
    const suggestions = proposesPlan
      ? []
      : (parsed.permission_suggestions ?? []).filter(
          ({ type }) => type !== SET_MODE_SUGGESTION,
        );
    this.pending.set(requestId, {
      type: "approval",
      controlId,
      input: parsed.input,
      suggestions,
      planToolUseId:
        proposesPlan && parentCallId === null ? parsed.tool_use_id : null,
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
    const texts = new Map<string, string>();
    const asked = parsed.questions.map((question, index) => {
      const id = String(index);
      texts.set(id, question.question);
      return {
        id,
        header: question.header,
        prompt: question.question,
        options: question.options,
        // The harness always lets the user write their own answer.
        allowsFreeText: true,
        multiSelect: question.multiSelect ?? false,
        secret: false,
      };
    });
    // A question the chat could not carry or answer back ends the turn
    // instead of pausing it on a question nobody can answer.
    const questions = this.parse(
      chatLocalRunQuestionsSchema,
      asked,
      "question",
    );
    if (questions === null) {
      return;
    }
    const requestId = requestIdFor(controlId);
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
    const client = this.client;
    if (this.lifecycle.ended || client === null) {
      return respondError("turn_ended", "The turn has already ended.");
    }
    const result = interactionResult(interaction, response);
    if (Result.isError(result)) {
      return respondError("invalid_response", result.error);
    }
    // The call's own result follows from the harness once it has run.
    client.respond(interaction.controlId, result.value);
    if (
      interaction.type === "approval" &&
      interaction.planToolUseId !== null &&
      response.type === "approval" &&
      response.decision === "approve"
    ) {
      this.approvedPlans.add(interaction.planToolUseId);
    }
    this.settle(requestId);
    return Result.ok();
  }

  /**
   * An approved plan has run its `ExitPlanMode` call, which returned the CLI
   * to `default`; a turn started in plan mode now continues in its approved
   * mode. The switch waits for the call's result so the CLI's own exit from
   * plan mode has finished, and until it lands the CLI asks more, never less.
   */
  private leavePlanMode(failed: boolean) {
    const mode = this.approvedPlanMode;
    const client = this.client;
    if (failed || mode === null || client === null || this.lifecycle.ended) {
      return;
    }
    this.detached(this.switchMode(client, mode), "claude-turn.leavePlanMode");
  }

  private async switchMode(client: ClaudeCliClient, mode: string) {
    const switched = await client.request("set_permission_mode", { mode });
    if (Result.isError(switched)) {
      this.violation("The harness did not leave plan mode.");
    }
  }

  private async interrupt() {
    await this.lifecycle.interrupt(async (client) => {
      // The CLI confirms an interrupt with its result, not with this reply;
      // the lifecycle waits for that result either way.
      await settlesWithin(
        client.request("interrupt"),
        this.lifecycle.gracePeriodMs,
      );
      return true;
    });
  }
}
