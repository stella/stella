import { panic, Result } from "better-result";
import * as v from "valibot";

import {
  type HarnessInteractionResponse,
  HarnessRespondError,
  type HarnessTurn,
} from "../adapter";
import { createEventQueue } from "../event-queue";
import {
  type HarnessApprovalOption,
  type HarnessContinuation,
  type HarnessEvent,
  type HarnessQuestion,
  harnessSessionId,
  type HarnessToolCall,
  type HarnessUsage,
} from "../events";
import { HARNESS_TOOL_NAMES, unsupportedItem } from "../tool-parts";
import type {
  AppServerClient,
  AppServerExit,
  AppServerHandlers,
  Detached,
} from "./app-server-client";
import { classifyTurnFailure, mergeRateLimits } from "./errors";
import {
  codexItemHandling,
  isToolItem,
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

const requestIdFor = (jsonRpcId: CodexRequestId) =>
  `codex-request-${String(jsonRpcId)}`;

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
      secret: question.isSecret,
    };
  });

const ZERO_USAGE: HarnessUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

const settlesWithin = async (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), Bun.sleep(ms).then(() => false)]);

const respondError = (reason: HarnessRespondError["reason"], message: string) =>
  Result.err(new HarnessRespondError({ reason, message }));

/** The JSON-RPC result for an answer, or why the answer does not fit. */
const interactionResult = (
  pending: PendingInteraction,
  response: HarnessInteractionResponse,
): Result<unknown, string> => {
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
        : Result.ok({ decision: option.id });
    }
    case "permissions":
      if (response.type !== "approval") {
        return Result.err("This request takes an approval decision.");
      }
      switch (response.decision) {
        case "approve":
          return Result.ok({ permissions: pending.requested, scope: "turn" });
        case "deny":
          return Result.ok({ permissions: {}, scope: "turn" });
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
      const answers: [string, { answers: readonly string[] }][] = [];
      for (const question of pending.questions) {
        const given = response.answers[question.id] ?? [];
        if (given.length === 0) {
          return Result.err(`Question ${question.id} has no answer.`);
        }
        // Native replies are option labels; the label is the option's id.
        const labels = new Set(question.options.map(({ label }) => label));
        if (!question.allowsFreeText && given.some((a) => !labels.has(a))) {
          return Result.err(
            `Question ${question.id} takes one of its options.`,
          );
        }
        answers.push([question.id, { answers: given }]);
      }
      return Result.ok({ answers: Object.fromEntries(answers) });
    }
    default:
      pending satisfies never;
      return panic("Unhandled pending interaction");
  }
};

type CodexTurnSessionOptions = {
  gracePeriodMs: number;
  detached: Detached;
  /** The server name the turn registered the stella MCP binding under. */
  stellaServer: string;
};

export class CodexTurnSession {
  private readonly queue = createEventQueue<HarnessEvent>();
  private readonly terminal = Promise.withResolvers<undefined>();
  private readonly started = Promise.withResolvers<undefined>();
  private readonly gracePeriodMs: number;
  private client: AppServerClient | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private ended = false;
  private interrupting = false;
  private usage: HarnessUsage | null = null;
  private rateLimits: CodexRateLimits | null = null;
  private lastError: CodexTurnError | null = null;
  private readonly early: EarlyMessage[] = [];
  private readonly toolCalls = new Map<string, HarnessToolCall>();
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly resolved = new Set<string>();
  private readonly answeredByMessage = new Set<string>();
  private unsupportedItems = 0;

  private readonly detached: Detached;
  private readonly stellaServer: string;

  constructor({
    gracePeriodMs,
    detached,
    stellaServer,
  }: CodexTurnSessionOptions) {
    this.gracePeriodMs = gracePeriodMs;
    this.detached = detached;
    this.stellaServer = stellaServer;
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
      this.exited(exit);
    },
  };

  attach(client: AppServerClient) {
    this.client = client;
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
    this.turnId = options.turnId;
    // A queued turn is acknowledged without a start time; it cannot be
    // interrupted until `turn/started` arrives.
    if (options.startedAt !== null) {
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
    this.ended = true;
    this.queue.close();
  }

  turn(): HarnessTurn {
    return {
      events: this.queue.items,
      respond: async (response) => this.respond(response),
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
      this.detached(this.shutdown(), "codex-turn.shutdown");
    }
  }

  private violation(message: string) {
    this.emit({
      type: "turn.failed",
      failure: { type: "protocol_violation", message },
    });
  }

  private exited({ exitCode, signal }: AppServerExit) {
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
      case "failed":
        this.emit({
          type: "turn.failed",
          failure: classifyTurnFailure({
            error: turn.error ?? this.lastError,
            rateLimits: this.rateLimits,
          }),
        });
        return;
      case "inProgress":
        this.violation("turn/completed for a turn still in progress");
        return;
      default:
        turn.status satisfies never;
        panic("Unhandled Codex turn status");
    }
  }

  private tokenUsage(
    parsed: v.InferOutput<
      (typeof CODEX_NOTIFICATIONS)["thread/tokenUsage/updated"]
    > | null,
  ) {
    if (parsed === null || parsed.turnId !== this.turnId) {
      return;
    }
    // `last` is one model request; a turn makes several.
    const { last } = parsed.tokenUsage;
    const total = this.usage ?? ZERO_USAGE;
    this.usage = {
      inputTokens: total.inputTokens + last.inputTokens,
      cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens,
      outputTokens: total.outputTokens + last.outputTokens,
      reasoningOutputTokens:
        total.reasoningOutputTokens + last.reasoningOutputTokens,
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
    const requestId = requestIdFor(id);
    const questions = questionsFromParams(parsed.questions);
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
    if (this.ended || this.client === null) {
      return respondError("turn_ended", "The turn has already ended.");
    }
    const result = interactionResult(interaction, response);
    if (Result.isError(result)) {
      return respondError("invalid_response", result.error);
    }
    this.client.respond(interaction.jsonRpcId, result.value);
    this.settle(requestId);
    if (interaction.type !== "approval") {
      this.emit({
        type: "tool.completed",
        toolCall: interaction.toolCall,
        result: { content: JSON.stringify(result.value), status: "succeeded" },
      });
    }
    return Result.ok();
  }

  private async interrupt() {
    const client = this.client;
    if (this.ended || this.interrupting || client === null) {
      return;
    }
    this.interrupting = true;
    await settlesWithin(this.started.promise, this.gracePeriodMs);
    await client.request("turn/interrupt", {
      threadId: this.threadId,
      turnId: this.turnId,
    });
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
