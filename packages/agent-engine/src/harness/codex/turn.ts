import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  chatLocalRunAnswersRefusal,
  chatLocalRunQuestionsSchema,
} from "@stll/api-contract/chat-run-target";

import type {
  HarnessInteractionResponse,
  HarnessRespondError,
  HarnessTurn,
} from "../adapter";
import {
  type HarnessApprovalOption,
  harnessContextUsage,
  type HarnessContinuation,
  type HarnessEvent,
  type HarnessQuestion,
  harnessSessionId,
  type HarnessToolCall,
  type HarnessUsage,
} from "../events";
import { HARNESS_TOOL_NAMES, unsupportedItem } from "../tool-parts";
import {
  type Detached,
  HarnessTurnLifecycle,
  respondError,
  settlesWithin,
} from "../turn-lifecycle";
import type { AppServerClient, AppServerHandlers } from "./app-server-client";
import {
  classifyTurnFailure,
  isCapacityFailure,
  mergeRateLimits,
} from "./errors";
import {
  codexItemHandling,
  isToolItem,
  planUpdateStep,
  reasoningText,
  toolCallForItem,
  toolResultForItem,
} from "./items";
import {
  CODEX_NOTIFICATIONS,
  CODEX_SERVER_REQUESTS,
  CodexItemSchema,
  type CodexNotificationMethod,
  type CodexRateLimits,
  type CodexRequestId,
  type CodexServerRequestMethod,
  type CodexTurnError,
  isCodexItemType,
  isCodexNotificationMethod,
  isCodexServerRequestMethod,
  METHOD_NOT_FOUND,
  TurnStartResponseSchema,
} from "./protocol";

/**
 * One Codex turn: routes the app-server's notifications and requests for the
 * turn into harness events, and carries answers back over the live JSON-RPC
 * path. The process hosts exactly this turn and is shut down when it ends.
 *
 * Protocol traps handled here, adapted from t3code (MIT,
 * `docs/internals/providers.md`): an async question arrives on a completed
 * agent message and is answered by the next user message, not by a response;
 * blocking questions and approvals keep their pending response; a queued
 * turn cannot be interrupted until it has started; approval replies use the
 * native decision ids verbatim.
 */

/** Native approval decisions, as the runner protocol's decisions. */
export const CODEX_APPROVAL_OPTIONS = [
  { id: "accept", decision: "approve" },
  { id: "acceptForSession", decision: "approve_for_session" },
  { id: "decline", decision: "deny" },
] as const satisfies readonly HarnessApprovalOption[];

/** A permissions request is answered with a grant, not a decision id. */
const PERMISSION_OPTIONS = [
  { id: "grant", decision: "approve" },
  { id: "deny", decision: "deny" },
] as const satisfies readonly HarnessApprovalOption[];

/** JSON-RPC ids `7` and `"7"` are different requests, so the type is kept. */
const requestIdFor = (jsonRpcId: CodexRequestId) =>
  `codex-request-${typeof jsonRpcId}-${String(jsonRpcId)}`;

/** Stands in for a secret answer anywhere outside the reply to the harness. */
const SECRET_ANSWER = "[secret answer]";

type PendingInteraction =
  | { type: "approval"; jsonRpcId: CodexRequestId }
  | {
      type: "permissions";
      jsonRpcId: CodexRequestId;
      toolCall: HarnessToolCall;
      requested: Record<string, unknown>;
    }
  | {
      type: "question";
      jsonRpcId: CodexRequestId;
      toolCall: HarnessToolCall;
      questions: readonly HarnessQuestion[];
    };

type EarlyMessage =
  | { kind: "notification"; method: CodexNotificationMethod; params: unknown }
  | {
      kind: "request";
      id: CodexRequestId;
      method: CodexServerRequestMethod;
      params: unknown;
    };

type QuestionParams = v.InferOutput<
  (typeof CODEX_SERVER_REQUESTS)["item/tool/requestUserInput"]["params"]
>["questions"];

const questionsFromParams = (questions: QuestionParams): HarnessQuestion[] =>
  questions.map((question) => {
    const options = question.options ?? [];
    return {
      id: question.id,
      header: question.header,
      prompt: question.question,
      options,
      allowsFreeText: question.isOther || options.length === 0,
      // Codex states no multiple choice: an answer picks one option.
      multiSelect: false,
      secret: question.isSecret,
    };
  });

const ZERO_USAGE: HarnessUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  context: null,
};

/**
 * The JSON-RPC result for an answer (`reply`), and the same result as the
 * turn's stream may show it (`shown`), or why the answer does not fit.
 */
type InteractionResult = { reply: unknown; shown: unknown };

const sameResult = (reply: unknown): InteractionResult => ({
  reply,
  shown: reply,
});

const interactionResult = (
  pending: PendingInteraction,
  response: HarnessInteractionResponse,
): Result<InteractionResult, string> => {
  switch (pending.type) {
    case "approval": {
      if (response.type !== "approval") {
        return Result.err("This request takes an approval decision.");
      }
      const option = CODEX_APPROVAL_OPTIONS.find(
        ({ decision }) => decision === response.decision,
      );
      return option === undefined
        ? Result.err("The harness does not offer this decision.")
        : Result.ok(sameResult({ decision: option.id }));
    }
    case "permissions":
      if (response.type !== "approval") {
        return Result.err("This request takes an approval decision.");
      }
      switch (response.decision) {
        case "approve":
          return Result.ok(
            sameResult({ permissions: pending.requested, scope: "turn" }),
          );
        case "deny":
          return Result.ok(sameResult({ permissions: {}, scope: "turn" }));
        case "approve_for_session":
          return Result.err("The harness does not offer this decision.");
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
      const answers: [string, { answers: readonly string[] }][] = [];
      const shown: [string, { answers: readonly string[] }][] = [];
      for (const question of pending.questions) {
        // Native replies are option labels; the label is the option's id.
        const given = response.answers[question.id] ?? [];
        answers.push([question.id, { answers: given }]);
        shown.push([
          question.id,
          { answers: question.secret ? given.map(() => SECRET_ANSWER) : given },
        ]);
      }
      return Result.ok({
        reply: { answers: Object.fromEntries(answers) },
        shown: { answers: Object.fromEntries(shown) },
      });
    }
    default:
      pending satisfies never;
      return panic("Unhandled pending interaction");
  }
};

/**
 * A turn that fails because the model is at capacity continues on the same
 * thread with empty input, after a delay that doubles from `baseDelayMs` up
 * to `maxDelayMs`, at most `maxAttempts` times. `sleep` waits out each delay,
 * so a test decides when a continuation starts.
 */
export type CodexCapacityRetry = {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (delayMs: number) => Promise<void>;
};

type CodexTurnSessionOptions = {
  gracePeriodMs: number;
  detached: Detached;
  /** The server name the turn registered the stella MCP binding under. */
  stellaServer: string;
  capacityRetry: CodexCapacityRetry;
};

export class CodexTurnSession {
  private readonly started = Promise.withResolvers<undefined>();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private usage: HarnessUsage | null = null;
  private rateLimits: CodexRateLimits | null = null;
  private lastError: CodexTurnError | null = null;
  private readonly early: EarlyMessage[] = [];
  private readonly toolCalls = new Map<string, HarnessToolCall>();
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly resolved = new Set<string>();
  private readonly answeredByMessage = new Set<string>();
  private unsupportedItems = 0;
  /** Plan updates reported so far in this turn. */
  private planUpdates = 0;
  private capacityRetries = 0;
  /** Messages whose text streamed in part and whose item has not completed. */
  private readonly openMessages = new Set<string>();

  private readonly lifecycle: HarnessTurnLifecycle<AppServerClient>;
  private readonly stellaServer: string;
  private readonly capacityRetry: CodexCapacityRetry;
  private readonly detached: Detached;

  constructor({
    gracePeriodMs,
    detached,
    stellaServer,
    capacityRetry,
  }: CodexTurnSessionOptions) {
    this.lifecycle = new HarnessTurnLifecycle({
      gracePeriodMs,
      detached,
      name: "codex-turn",
    });
    this.stellaServer = stellaServer;
    this.capacityRetry = capacityRetry;
    this.detached = detached;
  }

  /** Handlers for the process; messages before `begin` are held. */
  readonly handlers: AppServerHandlers = {
    notification: (method, params) => {
      if (!isCodexNotificationMethod(method)) {
        return;
      }
      if (method === "account/rateLimits/updated" || this.turnId !== null) {
        this.notification(method, params);
        return;
      }
      this.early.push({ kind: "notification", method, params });
    },
    request: (id, method, params) => {
      if (!isCodexServerRequestMethod(method)) {
        this.client?.respondError(
          id,
          METHOD_NOT_FOUND,
          `Stella does not answer ${method}.`,
        );
        return;
      }
      if (this.turnId === null) {
        this.early.push({ kind: "request", id, method, params });
        return;
      }
      this.request(id, method, params);
    },
    violation: (message) => {
      this.violation(message);
    },
    exit: (exit) => {
      this.lifecycle.exited(exit);
    },
  };

  attach(client: AppServerClient) {
    this.lifecycle.attach(client);
  }

  private get client(): AppServerClient | null {
    return this.lifecycle.client;
  }

  /** The turn was accepted: announce the session and release held messages. */
  begin(options: {
    threadId: string;
    turnId: string;
    startedAt: number | null;
    continuation: HarnessContinuation;
  }) {
    this.threadId = options.threadId;
    this.emit({
      type: "session.started",
      sessionId: harnessSessionId(options.threadId),
      continuation: options.continuation,
    });
    this.release(options.turnId, options.startedAt);
  }

  /** Route the native turn's messages, including those held until now. */
  private release(turnId: string, startedAt: number | null) {
    if (this.lifecycle.ended) {
      return;
    }
    this.turnId = turnId;
    // A queued turn is acknowledged without a start time; it cannot be
    // interrupted until `turn/started` arrives.
    if (startedAt !== null) {
      this.started.resolve(undefined);
    }
    for (const message of this.early.splice(0)) {
      if (message.kind === "notification") {
        this.notification(message.method, message.params);
      } else {
        this.request(message.id, message.method, message.params);
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
      interrupt: async () => this.interrupt(),
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
    params: unknown,
    what: string,
  ): v.InferOutput<TSchema> | null {
    const parsed = v.safeParse(schema, params);
    if (!parsed.success) {
      this.violation(`The harness sent a malformed ${what}.`);
      return null;
    }
    return parsed.output;
  }

  private notification(method: CodexNotificationMethod, params: unknown) {
    switch (method) {
      case "turn/started": {
        const parsed = this.parse(CODEX_NOTIFICATIONS[method], params, method);
        if (parsed?.turn.id === this.turnId) {
          this.started.resolve(undefined);
        }
        return;
      }
      case "turn/completed":
        this.turnCompleted(
          this.parse(CODEX_NOTIFICATIONS[method], params, method),
        );
        return;
      case "item/started":
      case "item/completed":
        this.itemNotification(method, params);
        return;
      case "item/agentMessage/delta": {
        const parsed = this.parse(CODEX_NOTIFICATIONS[method], params, method);
        if (parsed !== null && parsed.turnId === this.turnId) {
          this.openMessages.add(parsed.itemId);
          this.emit({
            type: "text.delta",
            messageId: parsed.itemId,
            delta: parsed.delta,
          });
        }
        return;
      }
      case "error": {
        const parsed = this.parse(CODEX_NOTIFICATIONS[method], params, method);
        if (parsed === null || parsed.turnId !== this.turnId) {
          return;
        }
        if (parsed.willRetry) {
          this.emit({ type: "retrying", message: parsed.error.message });
          return;
        }
        this.lastError = parsed.error;
        return;
      }
      case "thread/tokenUsage/updated":
        this.tokenUsage(
          this.parse(CODEX_NOTIFICATIONS[method], params, method),
        );
        return;
      case "serverRequest/resolved":
        this.requestResolved(
          this.parse(CODEX_NOTIFICATIONS[method], params, method),
        );
        return;
      case "account/rateLimits/updated": {
        const parsed = this.parse(CODEX_NOTIFICATIONS[method], params, method);
        if (parsed !== null) {
          this.rateLimits = mergeRateLimits(this.rateLimits, parsed.rateLimits);
        }
        return;
      }
      case "turn/plan/updated": {
        const parsed = this.parse(CODEX_NOTIFICATIONS[method], params, method);
        if (parsed !== null && parsed.turnId === this.turnId) {
          this.planUpdates += 1;
          this.emit({
            type: "tool.completed",
            ...planUpdateStep(parsed, this.planUpdates),
          });
        }
        return;
      }
      default:
        method satisfies never;
        panic("Unhandled Codex notification");
    }
  }

  private turnCompleted(
    parsed: v.InferOutput<
      (typeof CODEX_NOTIFICATIONS)["turn/completed"]
    > | null,
  ) {
    if (parsed === null || parsed.turn.id !== this.turnId) {
      return;
    }
    const { turn } = parsed;
    switch (turn.status) {
      case "completed":
        this.emit({ type: "turn.completed", usage: this.usage });
        return;
      case "interrupted":
        this.emit({ type: "turn.interrupted" });
        return;
      case "failed": {
        const error = turn.error ?? this.lastError;
        if (this.retryAtCapacity(error)) {
          return;
        }
        this.failWith(error);
        return;
      }
      case "inProgress":
        this.violation("turn/completed for a turn still in progress");
        return;
      default:
        turn.status satisfies never;
        panic("Unhandled Codex turn status");
    }
  }

  private failWith(error: CodexTurnError | null) {
    this.emit({
      type: "turn.failed",
      failure: classifyTurnFailure({ error, rateLimits: this.rateLimits }),
    });
  }

  /**
   * Continue a turn the model's capacity ended. Messages are held until the
   * continuation's turn id is known, as they are before the first turn.
   *
   * Continuing repeats nothing the chat already shows: Codex keeps every
   * completed item in the thread, and the continuation's empty input resumes
   * after them. A message that streamed in part is the exception (Codex keeps
   * no partial item, so the continuation would write it again), so such a
   * turn fails instead.
   */
  private retryAtCapacity(error: CodexTurnError | null): boolean {
    const { maxAttempts, baseDelayMs, maxDelayMs } = this.capacityRetry;
    if (
      !isCapacityFailure(error) ||
      this.lifecycle.interrupting ||
      this.openMessages.size > 0 ||
      this.capacityRetries >= maxAttempts
    ) {
      return false;
    }
    this.capacityRetries += 1;
    const delayMs = Math.min(
      baseDelayMs * 2 ** (this.capacityRetries - 1),
      maxDelayMs,
    );
    this.turnId = null;
    this.lastError = null;
    this.emit({
      type: "retrying",
      message: error?.message ?? "The model is at capacity.",
    });
    this.detached(this.continueAfter(delayMs, error), "codex-turn.continue");
    return true;
  }

  private async continueAfter(delayMs: number, error: CodexTurnError | null) {
    await this.capacityRetry.sleep(delayMs);
    const client = this.client;
    if (
      this.lifecycle.ended ||
      this.lifecycle.interrupting ||
      client === null
    ) {
      return;
    }
    const started = await client.request("turn/start", {
      threadId: this.threadId,
      input: [],
    });
    // An interrupt during the request ends the turn; `failWith` and `release`
    // are both no-ops on an ended turn.
    const parsed = Result.isOk(started)
      ? v.safeParse(TurnStartResponseSchema, started.value)
      : null;
    if (parsed === null || !parsed.success) {
      this.failWith(error);
      return;
    }
    this.release(parsed.output.turn.id, parsed.output.turn.startedAt ?? null);
  }

  private tokenUsage(
    parsed: v.InferOutput<
      (typeof CODEX_NOTIFICATIONS)["thread/tokenUsage/updated"]
    > | null,
  ) {
    if (parsed === null || parsed.turnId !== this.turnId) {
      return;
    }
    // `last` is one model request; a turn makes several. The context is the
    // last request's prompt and answer, which the next request carries.
    const { last, modelContextWindow } = parsed.tokenUsage;
    const total = this.usage ?? ZERO_USAGE;
    this.usage = {
      inputTokens: total.inputTokens + last.inputTokens,
      cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens,
      outputTokens: total.outputTokens + last.outputTokens,
      reasoningOutputTokens:
        total.reasoningOutputTokens + last.reasoningOutputTokens,
      context: harnessContextUsage(
        last.inputTokens + last.outputTokens,
        modelContextWindow,
      ),
    };
  }

  private itemNotification(
    method: "item/started" | "item/completed",
    params: unknown,
  ) {
    const envelope = this.parse(CODEX_NOTIFICATIONS[method], params, method);
    if (envelope === null || envelope.turnId !== this.turnId) {
      return;
    }
    const { type, id } = envelope.item;
    if (!isCodexItemType(type)) {
      // A kind newer than the pinned protocol: shown as a failed activity
      // once it completes, so the turn visibly did something Stella skipped.
      if (method === "item/completed") {
        this.unsupportedItems += 1;
        const unknown = unsupportedItem(
          id ?? `codex-unsupported-${String(this.unsupportedItems)}`,
          type,
        );
        this.emit({ type: "tool.completed", ...unknown });
      }
      return;
    }
    if (codexItemHandling(type) === "ignore") {
      return;
    }
    const item = this.parse(
      CodexItemSchema,
      v.parse(v.object({ item: v.unknown() }), params).item,
      `${method} item`,
    );
    if (item === null) {
      return;
    }
    if (method === "item/started") {
      if (isToolItem(item)) {
        const toolCall = toolCallForItem(item, this.stellaServer);
        this.toolCalls.set(toolCall.id, toolCall);
        this.emit({ type: "tool.started", toolCall });
      }
      return;
    }
    switch (item.type) {
      case "agentMessage":
        this.openMessages.delete(item.id);
        this.emit({
          type: "text.completed",
          messageId: item.id,
          text: item.text,
        });
        if (item.delivery === "async" && (item.questions ?? []).length > 0) {
          this.asyncQuestions(item.id, item.questions ?? []);
        }
        return;
      case "reasoning": {
        const text = reasoningText(item);
        if (text !== "") {
          this.emit({ type: "reasoning.completed", messageId: item.id, text });
        }
        return;
      }
      case "commandExecution":
      case "fileChange":
      case "mcpToolCall":
      case "webSearch": {
        const toolCall = toolCallForItem(item, this.stellaServer);
        this.toolCalls.set(toolCall.id, toolCall);
        this.emit({
          type: "tool.completed",
          toolCall,
          result: toolResultForItem(item),
        });
        return;
      }
      default:
        item satisfies never;
        panic("Unhandled Codex item");
    }
  }

  /** Async questions do not block; the user answers with the next message. */
  private asyncQuestions(
    itemId: string,
    questions: readonly { title: string; options: string[] | null }[],
  ) {
    const requestId = `codex-async-${itemId}`;
    this.answeredByMessage.add(requestId);
    const asked = questions.map((question, index): HarnessQuestion => ({
      id: String(index),
      header: "Question",
      prompt: question.title,
      options: (question.options ?? []).map((label) => ({
        label,
        description: "",
      })),
      allowsFreeText: true,
      multiSelect: false,
      secret: false,
    }));
    this.emit({
      type: "question.requested",
      request: {
        requestId,
        answerWith: "next_message",
        questions: asked,
        toolCall: {
          id: `${itemId}:questions`,
          name: HARNESS_TOOL_NAMES.question,
          input: { questions: asked },
        },
      },
    });
  }

  private requestResolved(
    parsed: v.InferOutput<
      (typeof CODEX_NOTIFICATIONS)["serverRequest/resolved"]
    > | null,
  ) {
    if (parsed === null) {
      return;
    }
    const requestId = requestIdFor(parsed.requestId);
    const interaction = this.pending.get(requestId);
    if (interaction === undefined) {
      return;
    }
    // Withdrawn by the harness, typically because the turn is stopping.
    this.settle(requestId);
    if (interaction.type !== "approval") {
      this.emit({
        type: "tool.completed",
        toolCall: interaction.toolCall,
        result: {
          content: JSON.stringify({ status: "withdrawn" }),
          status: "failed",
        },
      });
    }
  }

  private settle(requestId: string) {
    this.pending.delete(requestId);
    this.resolved.add(requestId);
    this.emit({ type: "interaction.resolved", requestId });
  }

  private request(
    id: CodexRequestId,
    method: CodexServerRequestMethod,
    params: unknown,
  ) {
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        this.approval(id, method, params);
        return;
      case "item/permissions/requestApproval":
        this.permissions(id, params);
        return;
      case "item/tool/requestUserInput":
        this.blockingQuestion(id, params);
        return;
      case "mcpServer/elicitation/request":
      case "item/tool/call":
      case "applyPatchApproval":
      case "execCommandApproval":
        this.client?.respond(id, CODEX_SERVER_REQUESTS[method].response);
        return;
      case "account/chatgptAuthTokens/refresh":
      case "attestation/generate":
        this.client?.respondError(
          id,
          METHOD_NOT_FOUND,
          `Stella does not answer ${method}.`,
        );
        return;
      default:
        method satisfies never;
        panic("Unhandled Codex server request");
    }
  }

  private approval(
    id: CodexRequestId,
    method:
      | "item/commandExecution/requestApproval"
      | "item/fileChange/requestApproval",
    params: unknown,
  ) {
    const parsed = this.parse(
      CODEX_SERVER_REQUESTS[method].params,
      params,
      method,
    );
    if (parsed === null) {
      return;
    }
    const requestId = requestIdFor(id);
    const isFileChange = method === "item/fileChange/requestApproval";
    const command = "command" in parsed ? (parsed.command ?? "") : "";
    const fallback: HarnessToolCall = isFileChange
      ? {
          id: parsed.itemId,
          name: HARNESS_TOOL_NAMES.fileChange,
          input: { changes: [] },
        }
      : {
          id: parsed.itemId,
          name: HARNESS_TOOL_NAMES.commandExecution,
          input: { command },
        };
    this.pending.set(requestId, { type: "approval", jsonRpcId: id });
    this.emit({
      type: "approval.requested",
      request: {
        requestId,
        kind: isFileChange ? "file_change" : "command",
        toolCall: this.toolCalls.get(parsed.itemId) ?? fallback,
        reason: parsed.reason ?? null,
        options: CODEX_APPROVAL_OPTIONS,
      },
    });
  }

  private permissions(id: CodexRequestId, params: unknown) {
    const method = "item/permissions/requestApproval";
    const parsed = this.parse(
      CODEX_SERVER_REQUESTS[method].params,
      params,
      method,
    );
    if (parsed === null) {
      return;
    }
    // The grant echoes what was asked for, without the absent parts.
    const requested = Object.fromEntries(
      Object.entries(parsed.permissions).filter(
        ([, value]) => value !== null && value !== undefined,
      ),
    );
    const requestId = requestIdFor(id);
    const toolCall = {
      id: `${parsed.itemId}:permissions`,
      name: HARNESS_TOOL_NAMES.permissions,
      input: requested,
    };
    this.pending.set(requestId, {
      type: "permissions",
      jsonRpcId: id,
      toolCall,
      requested,
    });
    this.emit({
      type: "approval.requested",
      request: {
        requestId,
        kind: "tool",
        toolCall,
        reason: parsed.reason ?? null,
        options: PERMISSION_OPTIONS,
      },
    });
  }

  private blockingQuestion(id: CodexRequestId, params: unknown) {
    const method = "item/tool/requestUserInput";
    const parsed = this.parse(
      CODEX_SERVER_REQUESTS[method].params,
      params,
      method,
    );
    if (parsed === null) {
      return;
    }
    // A question the chat could not carry or answer back ends the turn
    // instead of pausing it on a question nobody can answer.
    const questions = this.parse(
      chatLocalRunQuestionsSchema,
      questionsFromParams(parsed.questions),
      method,
    );
    if (questions === null) {
      return;
    }
    const requestId = requestIdFor(id);
    const toolCall = {
      id: parsed.itemId,
      name: HARNESS_TOOL_NAMES.question,
      input: { questions },
    };
    this.pending.set(requestId, {
      type: "question",
      jsonRpcId: id,
      toolCall,
      questions,
    });
    this.emit({
      type: "question.requested",
      request: { requestId, answerWith: "response", questions, toolCall },
    });
  }

  private respond(
    response: HarnessInteractionResponse,
  ): Result<void, HarnessRespondError> {
    const { requestId } = response;
    if (this.answeredByMessage.has(requestId)) {
      return respondError(
        "answer_with_message",
        "This question is answered by the next user message.",
      );
    }
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
    client.respond(interaction.jsonRpcId, result.value.reply);
    this.settle(requestId);
    if (interaction.type !== "approval") {
      this.emit({
        type: "tool.completed",
        toolCall: interaction.toolCall,
        result: {
          content: JSON.stringify(result.value.shown),
          status: "succeeded",
        },
      });
    }
    return Result.ok();
  }

  private async interrupt() {
    await this.lifecycle.interrupt(async (client) => {
      await settlesWithin(this.started.promise, this.lifecycle.gracePeriodMs);
      if (this.turnId === null) {
        // Between a capacity failure and its continuation no turn is running:
        // nothing to ask, so the turn ends as interrupted at once.
        return false;
      }
      const requested = await client.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.turnId,
      });
      return Result.isOk(requested);
    });
  }
}
