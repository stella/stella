/**
 * The post-deploy smoke's real chat turn, run as the dedicated `ai` smoke
 * organization against a deployed API.
 *
 * The organization's AI is configured through the regular organization
 * settings API, so a real owner's path is the one under test. The journey is
 * one approval-gated server tool, approved, followed by a text answer; a
 * reload that must show the call stored complete and the turn settled; and a
 * follow-up message in the same thread.
 *
 * Every request is bounded: one fresh thread, three chat sends, short prompts
 * that ask for one-word answers, and a deadline plus a byte cap on each
 * stream. Provider-side spend limits live on the provider key.
 *
 * The journey removes what it creates, whether it passes or fails: the thread
 * (with its messages) and the organization's AI config, so the provider key
 * is not left stored between runs. Checks report states, ids and counts only;
 * no prompt or model text is printed.
 *
 * Self-contained like the smoke that runs it: nothing here opens a database
 * connection or reads the app's env module.
 */
import { TaggedError } from "better-result";
import type { Static } from "elysia";
import * as v from "valibot";

import { Temporal } from "@stll/time";

import type {
  agUiSendMessageBodySchema,
  ChatSendRequest,
} from "@/api/handlers/chat/chat-schema";
import {
  findDroppedParts,
  findUnsettledToolCallsForOutcome,
} from "@/api/handlers/chat/chat-turn-settlement";
import type { ToolCallState } from "@/api/handlers/chat/chat-turn-settlement";
import { SPAWN_SUBAGENTS_TOOL_NAME } from "@/api/handlers/chat/tools/subagent-tool-shared";
import type { ChatTurnOutcome } from "@/api/handlers/chat/types";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedChatMessageId } from "@/api/lib/safe-id-boundaries";

type SmokeCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

/** The one model the smoke organization runs, on every role: the
 *  lowest-cost OpenAI model in the catalog. */
const SMOKE_AI_PROVIDER = "openai";
export const SMOKE_AI_MODEL_ID = "gpt-6-luna";

const SMOKE_AI_ROLES = ["fast", "chat", "reasoning", "pdf"] as const;

export const SMOKE_APPROVAL_TOOL_NAME = SPAWN_SUBAGENTS_TOOL_NAME;

const SMOKE_FIRST_PROMPT =
  `Deployment check. Call ${SMOKE_APPROVAL_TOOL_NAME} once with exactly one ` +
  'subagent whose task is "Reply with the word OK." When it returns, ' +
  "answer me with one word.";
const SMOKE_FOLLOW_UP_PROMPT = "Reply with the word ok.";

const AI_CONFIG_TIMEOUT_MS = 30_000;
const THREAD_READ_TIMEOUT_MS = 15_000;
const CHAT_TURN_TIMEOUT_MS = 180_000;
/** A one-word turn streams a few kilobytes; a runaway turn fails the smoke
 *  instead of being read on. */
const CHAT_TURN_MAX_BYTES = 256 * 1024;
const CLEANUP_TIMEOUT_MS = 15_000;
const SETTLE_POLL_ATTEMPTS = 10;
const SETTLE_POLL_INTERVAL_MS = 1000;
const RESPONSE_DETAIL_MAX_CHARS = 300;

const AI_UNAVAILABLE_STATUS = 403;
const AI_UNAVAILABLE_MESSAGE_FRAGMENT = "AI is not available";

const AG_UI_EVENT = {
  runError: "RUN_ERROR",
  runFinished: "RUN_FINISHED",
  textContent: "TEXT_MESSAGE_CONTENT",
  toolCallStart: "TOOL_CALL_START",
} as const;

type SmokeRequestInit = {
  body?: unknown;
  method?: "DELETE" | "GET" | "POST";
  timeoutMs: number;
};

/** One authenticated request against the deployment under test. */
export type SmokeRequest = (
  path: string,
  init: SmokeRequestInit,
) => Promise<Response>;

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

const streamFrameSchema = v.object({
  type: v.string(),
  delta: v.optional(v.string()),
  message: v.optional(v.string()),
});

type StreamFrame = v.InferOutput<typeof streamFrameSchema>;

type ScannedStream = {
  /** Every `data:` payload that parsed as JSON. */
  data: unknown[];
  /** Terminated `data:` lines that are not JSON. */
  malformedLines: number;
  /** The text ends inside a `data:` line that does not parse (yet). */
  partialTail: boolean;
};

/**
 * The `data:` payloads of an SSE body. Only the last, unterminated line may be
 * incomplete; a terminated line that is not JSON is a corrupt frame.
 */
const scanStreamData = (text: string): ScannedStream => {
  const lines = text.split(/\r?\n/u);
  const lastIndex = lines.length - 1;
  const scanned: ScannedStream = {
    data: [],
    malformedLines: 0,
    partialTail: false,
  };
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const payload = line.slice("data:".length).trim();
    if (payload.length === 0) {
      continue;
    }
    try {
      scanned.data.push(JSON.parse(payload));
    } catch {
      if (index === lastIndex) {
        scanned.partialTail = true;
      } else {
        scanned.malformedLines += 1;
      }
    }
  }
  return scanned;
};

/** The JSON payloads of an SSE prefix's `data:` lines. */
export const parseStreamDataFrames = (text: string): unknown[] =>
  scanStreamData(text).data;

const typedFramesOf = (data: readonly unknown[]): StreamFrame[] =>
  data.flatMap((frame) => {
    const parsed = v.safeParse(streamFrameSchema, frame);
    return parsed.success ? [parsed.output] : [];
  });

export const streamFramesOf = (text: string): StreamFrame[] =>
  typedFramesOf(parseStreamDataFrames(text));

type StreamReader = {
  cancel: () => Promise<unknown>;
  read: () => Promise<{ done: boolean; value?: Uint8Array | undefined }>;
};

class StreamDeadlineError extends TaggedError("StreamDeadlineError")<{
  message: string;
}> {}

export const readWithDeadline = async (
  reader: StreamReader,
  deadline: number,
  timeoutMessage = "Chat stream did not finish before timeout",
): Promise<Awaited<ReturnType<StreamReader["read"]>>> => {
  const remainingMs = deadline - Temporal.Now.instant().epochMilliseconds;
  if (remainingMs <= 0) {
    throw new StreamDeadlineError({ message: timeoutMessage });
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new StreamDeadlineError({ message: timeoutMessage }));
      reader.cancel().catch(() => undefined);
    }, remainingMs);
  });

  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

/**
 * Read a whole chat stream, bounded by a deadline and a byte cap. Returns the
 * text, or why reading stopped early.
 */
export const readTurnStream = async (
  response: Response,
  {
    maxBytes = CHAT_TURN_MAX_BYTES,
    timeoutMs = CHAT_TURN_TIMEOUT_MS,
  }: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<{ text: string } | { error: string }> => {
  if (!response.body) {
    return { text: "" };
  }
  const decoder = new TextDecoder();
  const deadline = Temporal.Now.instant().epochMilliseconds + timeoutMs;
  let text = "";
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await readWithDeadline(reader, deadline);
      if (done) {
        return { text: text + decoder.decode() };
      }
      if (value) {
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          return { error: `stream exceeded ${String(maxBytes)} bytes` };
        }
        text += decoder.decode(value, { stream: true });
      }
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
};

/** A finished turn stream: every frame well formed, no run error, and the
 *  run finished. */
export const evaluateTurnStream = (name: string, text: string): SmokeCheck => {
  const scanned = scanStreamData(text);
  const frames = typedFramesOf(scanned.data);
  const untyped = scanned.data.length - frames.length;
  if (scanned.malformedLines > 0 || scanned.partialTail || untyped > 0) {
    return {
      name,
      ok: false,
      detail:
        `stream carried corrupt frames: ${String(scanned.malformedLines)} ` +
        `not JSON, ${String(untyped)} without a type${
          scanned.partialTail ? ", and ended mid-frame" : ""
        }`,
    };
  }
  const runError = frames.find(({ type }) => type === AG_UI_EVENT.runError);
  if (runError) {
    return {
      name,
      ok: false,
      detail: `stream emitted RUN_ERROR: ${runError.message ?? "no message"}`,
    };
  }
  if (!frames.some(({ type }) => type === AG_UI_EVENT.runFinished)) {
    return { name, ok: false, detail: "stream ended without RUN_FINISHED" };
  }
  return {
    name,
    ok: true,
    detail: `${String(frames.length)} frames, finished`,
  };
};

/** Frames that prove a turn made progress, for callers reading a prefix. */
export const isProgressFrame = ({ delta, type }: StreamFrame): boolean =>
  type === AG_UI_EVENT.runFinished ||
  type === AG_UI_EVENT.toolCallStart ||
  (type === AG_UI_EVENT.textContent && delta !== undefined && delta !== "");

export const isRunErrorFrame = ({ type }: StreamFrame): boolean =>
  type === AG_UI_EVENT.runError;

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const buildSmokeAIConfigBody = (apiKey: string) => {
  const selection = { provider: SMOKE_AI_PROVIDER, modelId: SMOKE_AI_MODEL_ID };
  return {
    providers: [{ provider: SMOKE_AI_PROVIDER, apiKey }],
    overrideModels: Object.fromEntries(
      SMOKE_AI_ROLES.map((role) => [role, selection]),
    ),
  };
};

type ChatSmokeBody = Static<typeof agUiSendMessageBodySchema>;

export const buildUserTurnBody = ({
  runId,
  text,
  threadId,
}: {
  runId: string;
  text: string;
  threadId: SafeId<"chatThread">;
}): ChatSmokeBody => {
  const message = {
    id: createSafeId<"chatMessage">(),
    role: "user",
    parts: [{ type: "text", content: text }],
  } as const satisfies ChatSendRequest["message"];
  const forwardedProps = {
    threadId,
    runId,
    sendMode: "rawOverride",
    message,
  } as const satisfies ChatSendRequest;
  return {
    threadId,
    runId,
    state: {},
    messages: [message],
    tools: [],
    context: [],
    forwardedProps,
    data: forwardedProps,
  } satisfies ChatSmokeBody;
};

/**
 * The continuation a chat client posts when the user approves `callId` on the
 * stored assistant message: the message's parts as stored, with that call
 * marked approved, resuming the interrupted run.
 */
export const buildApprovalBody = ({
  approvalId,
  callId,
  interruptedRunId,
  message,
  runId,
  threadId,
}: {
  approvalId: string;
  callId: string;
  interruptedRunId: string;
  message: StoredMessage;
  runId: string;
  threadId: SafeId<"chatThread">;
}): ChatSmokeBody => {
  const parts = message.rawParts.map((part) => {
    const call = v.safeParse(toolCallPartSchema, part);
    if (!call.success || call.output.id !== callId) {
      return part;
    }
    return {
      ...(typeof part === "object" && part !== null ? part : {}),
      approval: {
        needsApproval: true,
        ...call.output.approval,
        id: approvalId,
        approved: true,
      },
      state: "approval-responded",
    };
  });
  const continuationMessage = {
    id: brandPersistedChatMessageId(message.id),
    role: "assistant",
    parts,
  } as const;
  const resume: Extract<ChatSendRequest, { resume: unknown }>["resume"] = [
    {
      interruptId: approvalId,
      status: "resolved",
      payload: { approved: true },
    },
  ];
  const forwardedProps = {
    threadId,
    runId,
    sendMode: "rawOverride",
    message: continuationMessage,
    parentRunId: interruptedRunId,
    resume,
  } as const satisfies ChatSendRequest;
  return {
    threadId,
    runId,
    state: {},
    messages: [continuationMessage],
    tools: [],
    context: [],
    forwardedProps,
    data: forwardedProps,
    parentRunId: interruptedRunId,
    resume,
  } satisfies ChatSmokeBody;
};

// ---------------------------------------------------------------------------
// Stored thread
// ---------------------------------------------------------------------------

const TOOL_CALL_STATES = {
  "approval-requested": true,
  "approval-responded": true,
  "awaiting-input": true,
  complete: true,
  error: true,
  "input-complete": true,
  "input-streaming": true,
} as const satisfies Record<ToolCallState, true>;

const TURN_OUTCOME_TYPES = {
  "awaiting-user": true,
  cancelled: true,
  completed: true,
  failed: true,
  interrupted: true,
} as const satisfies Record<ChatTurnOutcome["type"], true>;

const picklistOf = <TKey extends string>(record: Record<TKey, true>) =>
  v.picklist(Object.keys(record).filter((key): key is TKey => key in record));

const toolCallPartSchema = v.object({
  type: v.literal("tool-call"),
  id: v.string(),
  name: v.string(),
  arguments: v.string(),
  state: picklistOf(TOOL_CALL_STATES),
  approval: v.optional(
    v.object({
      id: v.string(),
      needsApproval: v.boolean(),
      approved: v.optional(v.boolean()),
    }),
  ),
  output: v.optional(v.unknown()),
});

const textPartSchema = v.object({
  type: v.literal("text"),
  content: v.string(),
});

const threadMessagesSchema = v.object({
  messages: v.array(
    v.object({
      id: v.string(),
      role: v.string(),
      parts: v.array(v.unknown()),
      metadata: v.optional(
        v.object({
          turnOutcome: v.optional(
            v.object({
              type: picklistOf(TURN_OUTCOME_TYPES),
              interaction: v.optional(
                v.object({ type: v.string(), toolCallId: v.string() }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

type ParsedToolCall = v.InferOutput<typeof toolCallPartSchema>;
type ToolCall = Omit<ParsedToolCall, "approval"> & {
  approval?: { approved?: boolean; id: string; needsApproval: boolean };
};

/** The parsed call in the shape the settlement rules read, without absent
 *  fields. */
const toToolCall = ({ approval, ...call }: ParsedToolCall): ToolCall => ({
  ...call,
  ...(approval === undefined
    ? {}
    : {
        approval: {
          id: approval.id,
          needsApproval: approval.needsApproval,
          ...(approval.approved === undefined
            ? {}
            : { approved: approval.approved }),
        },
      }),
});
type TurnOutcome = NonNullable<
  NonNullable<
    v.InferOutput<typeof threadMessagesSchema>["messages"][number]["metadata"]
  >["turnOutcome"]
>;

export type StoredMessage = {
  id: string;
  outcome: TurnOutcome | null;
  rawParts: unknown[];
  role: string;
  texts: string[];
  toolCalls: ToolCall[];
};

export const parseThreadMessages = (body: unknown): StoredMessage[] | null => {
  const parsed = v.safeParse(threadMessagesSchema, body);
  if (!parsed.success) {
    return null;
  }
  return parsed.output.messages.map((message) => ({
    id: message.id,
    outcome: message.metadata?.turnOutcome ?? null,
    rawParts: message.parts,
    role: message.role,
    texts: message.parts.flatMap((part) => {
      const text = v.safeParse(textPartSchema, part);
      return text.success && text.output.content.trim() !== ""
        ? [text.output.content]
        : [];
    }),
    toolCalls: message.parts.flatMap((part) => {
      const call = v.safeParse(toolCallPartSchema, part);
      return call.success ? [toToolCall(call.output)] : [];
    }),
  }));
};

const lastAssistantOf = (
  messages: readonly StoredMessage[],
): StoredMessage | undefined =>
  messages.findLast(({ role }) => role === "assistant");

/**
 * Tool calls any settled assistant message still holds open, by the same
 * settlement rule the API applies. A message without a stored outcome is held
 * to the completed-turn rule.
 */
const unsettledCallsOf = (messages: readonly StoredMessage[]) =>
  messages
    .filter(({ role }) => role === "assistant")
    .flatMap(({ id, outcome, toolCalls }) =>
      findUnsettledToolCallsForOutcome({
        outcome: outcome?.type ?? "completed",
        parts: toolCalls,
      }).map(({ state, toolCallId }) => ({
        messageId: id,
        state,
        toolCallId,
      })),
    );

type PendingApproval = {
  approvalId: string;
  callId: string;
  message: StoredMessage;
};

/** How many subagents a pending call's arguments ask for; null when the
 *  arguments do not parse. */
const requestedSubagentCount = (args: string): number | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null;
  }
  const input = v.safeParse(
    v.object({ subagents: v.array(v.unknown()) }),
    parsed,
  );
  return input.success ? input.output.subagents.length : null;
};

/** After the first send: the turn waits on exactly our tool's approval. */
export const evaluatePendingApproval = (
  messages: readonly StoredMessage[],
): { check: SmokeCheck; pending: PendingApproval | null } => {
  const name = "turn 1 awaits tool approval";
  const fail = (detail: string) => ({
    check: { name, ok: false, detail },
    pending: null,
  });
  const message = lastAssistantOf(messages);
  if (!message) {
    return fail("no assistant message stored");
  }
  const call = message.toolCalls.find(
    ({ name: toolName, state }) =>
      toolName === SMOKE_APPROVAL_TOOL_NAME && state === "approval-requested",
  );
  if (!call?.approval) {
    const seen = message.toolCalls.map(
      ({ name: toolName, state }) => `${toolName}:${state}`,
    );
    return fail(
      `no pending ${SMOKE_APPROVAL_TOOL_NAME} approval (tool calls: ${
        seen.length > 0 ? seen.join(", ") : "none"
      }; text: ${String(message.texts.length)} parts)`,
    );
  }
  const subagents = requestedSubagentCount(call.arguments);
  if (subagents !== 1) {
    // Refused before approving, so a model that batches more subtasks than
    // asked never runs them.
    return fail(
      `${SMOKE_APPROVAL_TOOL_NAME} asks for ${String(subagents ?? "unparseable")} subagents, expected 1`,
    );
  }
  if (
    message.outcome?.type !== "awaiting-user" ||
    message.outcome.interaction?.toolCallId !== call.id
  ) {
    return fail(
      `turn outcome is ${message.outcome?.type ?? "missing"}, expected awaiting-user on ${call.id}`,
    );
  }
  return {
    check: { name, ok: true, detail: `approval ${call.approval.id} pending` },
    pending: { approvalId: call.approval.id, callId: call.id, message },
  };
};

const hasOneCompletedSubagent = (output: unknown): boolean => {
  const parsed = v.safeParse(
    v.object({
      results: v.array(v.object({ status: v.string() })),
    }),
    output,
  );
  return (
    parsed.success &&
    parsed.output.results.length === 1 &&
    parsed.output.results[0]?.status === "completed"
  );
};

/**
 * After the approval: the call is stored complete with its output, the
 * continuation kept every earlier call, the model answered in text, and no
 * tool call is left open.
 */
export const evaluateApprovedTurn = ({
  messages,
  pending,
}: {
  messages: readonly StoredMessage[];
  pending: PendingApproval;
}): SmokeCheck => {
  const name = "turn 1 settles after approval";
  const fail = (detail: string): SmokeCheck => ({ name, ok: false, detail });
  const call = messages
    .flatMap(({ toolCalls }) => toolCalls)
    .find(({ id }) => id === pending.callId);
  if (!call) {
    return fail(`approved call ${pending.callId} is no longer stored`);
  }
  if (call.state !== "complete" || call.output === undefined) {
    return fail(
      `approved call is ${call.state}${call.output === undefined ? " without output" : ""}`,
    );
  }
  if (!hasOneCompletedSubagent(call.output)) {
    return fail("approved call's output is not exactly one completed subagent");
  }
  // A continuation settles the call in place on the message it continued;
  // losing or replacing that message is the regression, whatever else the
  // reload shows.
  const owner = messages.find(({ id }) => id === pending.message.id);
  if (!owner) {
    return fail(`continued message ${pending.message.id} is no longer stored`);
  }
  if (!owner.toolCalls.some(({ id }) => id === pending.callId)) {
    return fail(`approved call moved off continued message ${owner.id}`);
  }
  const dropped = findDroppedParts({
    continued: pending.message.toolCalls,
    stored: owner.toolCalls,
  });
  if (dropped) {
    return fail(
      `continuation dropped tool calls: ${dropped.droppedToolCallIds.join(", ")}`,
    );
  }
  const last = lastAssistantOf(messages);
  if (last?.id !== owner.id) {
    return fail(
      `continuation answered in a new message ${last?.id ?? "missing"} instead of ${owner.id}`,
    );
  }
  if (last.outcome?.type !== "completed") {
    return fail(`turn outcome is ${last.outcome?.type ?? "missing"}`);
  }
  if (last.texts.length === 0) {
    return fail("the model did not answer in text after the tool");
  }
  const unsettled = unsettledCallsOf(messages);
  if (unsettled.length > 0) {
    return fail(
      `open tool calls after settling: ${unsettled
        .map(({ state, toolCallId }) => `${toolCallId}:${state}`)
        .join(", ")}`,
    );
  }
  return { name, ok: true, detail: "call complete with output, text answer" };
};

/** After the follow-up: a newer assistant message answered and settled. */
export const evaluateFollowUpTurn = ({
  messages,
  previousAssistantId,
}: {
  messages: readonly StoredMessage[];
  previousAssistantId: string;
}): SmokeCheck => {
  const name = "turn 2 completes";
  const last = lastAssistantOf(messages);
  if (!last || last.id === previousAssistantId) {
    return { name, ok: false, detail: "no new assistant message stored" };
  }
  if (last.outcome?.type !== "completed" || last.texts.length === 0) {
    return {
      name,
      ok: false,
      detail: `turn outcome ${last.outcome?.type ?? "missing"} with ${String(
        last.texts.length,
      )} text parts`,
    };
  }
  const unsettled = unsettledCallsOf(messages);
  if (unsettled.length > 0) {
    return {
      name,
      ok: false,
      detail: `open tool calls: ${unsettled.map(({ toolCallId }) => toolCallId).join(", ")}`,
    };
  }
  return { name, ok: true, detail: "text answer, thread settled" };
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const truncate = (text: string): string =>
  text.length > RESPONSE_DETAIL_MAX_CHARS
    ? `${text.slice(0, RESPONSE_DETAIL_MAX_CHARS)}...`
    : text;

/**
 * A non-2xx chat send. For this organization "AI is not available" is a
 * configuration regression, never a pass.
 */
export const describeChatSendFailure = (
  status: number,
  body: string,
): string =>
  status === AI_UNAVAILABLE_STATUS &&
  body.includes(AI_UNAVAILABLE_MESSAGE_FRAGMENT)
    ? `${String(status)} AI is not available for the AI smoke organization ` +
      "even though its AI config was just saved: the organization AI " +
      "configuration no longer reaches chat"
    : `${String(status)} ${truncate(body)}`;

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

const sleep = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const provisionAIConfig = async (
  request: SmokeRequest,
  apiKey: string,
): Promise<SmokeCheck> => {
  const name = "POST /v1/organization-settings/ai-config";
  const response = await request("/v1/organization-settings/ai-config", {
    method: "POST",
    body: buildSmokeAIConfigBody(apiKey),
    timeoutMs: AI_CONFIG_TIMEOUT_MS,
  });
  if (isSuccess(response.status)) {
    await response.body?.cancel().catch(() => undefined);
    return {
      name,
      ok: true,
      detail: `${SMOKE_AI_PROVIDER}/${SMOKE_AI_MODEL_ID} on every role`,
    };
  }
  return {
    name,
    ok: false,
    detail:
      `${String(response.status)} ${truncate(await response.text())}. ` +
      "Check the smoke provider key (STAGING_SMOKE_OPENAI_API_KEY) and its " +
      "provider project limits.",
  };
};

const sendTurn = async (
  request: SmokeRequest,
  name: string,
  body: ChatSmokeBody,
): Promise<SmokeCheck> => {
  const response = await request("/v1/chat/", {
    method: "POST",
    body,
    timeoutMs: CHAT_TURN_TIMEOUT_MS,
  });
  if (!isSuccess(response.status)) {
    return {
      name,
      ok: false,
      detail: describeChatSendFailure(response.status, await response.text()),
    };
  }
  const stream = await readTurnStream(response);
  return "error" in stream
    ? { name, ok: false, detail: stream.error }
    : evaluateTurnStream(name, stream.text);
};

/**
 * Reload the thread until its last assistant message carries a turn outcome;
 * persistence may land just after the stream closes.
 */
const reloadSettledThread = async (
  request: SmokeRequest,
  threadId: SafeId<"chatThread">,
): Promise<StoredMessage[] | string> => {
  let lastProblem = "no reload attempted";
  for (let attempt = 0; attempt < SETTLE_POLL_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(SETTLE_POLL_INTERVAL_MS);
    }
    const response = await request(`/v1/chat/threads/${threadId}/messages`, {
      timeoutMs: THREAD_READ_TIMEOUT_MS,
    });
    if (!isSuccess(response.status)) {
      lastProblem = `${String(response.status)} ${truncate(await response.text())}`;
      continue;
    }
    const messages = parseThreadMessages(await response.json());
    if (messages === null) {
      return "thread messages did not match the expected shape";
    }
    if (lastAssistantOf(messages)?.outcome) {
      return messages;
    }
    lastProblem = "last assistant message has no turn outcome yet";
  }
  return lastProblem;
};

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** One cleanup request, reported as a check. Both deletes succeed when there
 *  is nothing left to delete. */
const cleanUp = async (
  request: SmokeRequest,
  name: string,
  path: string,
): Promise<SmokeCheck> => {
  try {
    const response = await request(path, {
      method: "DELETE",
      timeoutMs: CLEANUP_TIMEOUT_MS,
    });
    await response.body?.cancel().catch(() => undefined);
    return {
      name,
      ok: isSuccess(response.status),
      detail: String(response.status),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `request failed: ${describeError(error)}`,
    };
  }
};

/** The journey's steps, in order; each records its check. */
const runJourneySteps = async ({
  apiKey,
  checks,
  created,
  request,
  threadId,
}: {
  apiKey: string;
  checks: SmokeCheck[];
  created: { thread: boolean };
  request: SmokeRequest;
  threadId: SafeId<"chatThread">;
}): Promise<void> => {
  const record = (check: SmokeCheck): boolean => {
    checks.push(check);
    return check.ok;
  };
  const reload = async (name: string): Promise<StoredMessage[] | null> => {
    const messages = await reloadSettledThread(request, threadId);
    if (typeof messages === "string") {
      record({ name, ok: false, detail: messages });
      return null;
    }
    return messages;
  };

  if (!record(await provisionAIConfig(request, apiKey))) {
    return;
  }

  // The first send creates the thread, even when its stream then fails.
  created.thread = true;
  const firstRunId = Bun.randomUUIDv7();
  const firstTurn = await sendTurn(
    request,
    "POST /v1/chat/ (turn 1)",
    buildUserTurnBody({
      runId: firstRunId,
      text: SMOKE_FIRST_PROMPT,
      threadId,
    }),
  );
  if (
    !record({ ...firstTurn, detail: `${firstTurn.detail}; thread ${threadId}` })
  ) {
    return;
  }

  const afterFirst = await reload("reload after turn 1");
  if (!afterFirst) {
    return;
  }
  const { check: pendingCheck, pending } = evaluatePendingApproval(afterFirst);
  if (!record(pendingCheck) || !pending) {
    return;
  }

  const approval = await sendTurn(
    request,
    "POST /v1/chat/ (approval)",
    buildApprovalBody({
      approvalId: pending.approvalId,
      callId: pending.callId,
      interruptedRunId: firstRunId,
      message: pending.message,
      runId: Bun.randomUUIDv7(),
      threadId,
    }),
  );
  if (!record(approval)) {
    return;
  }

  const afterApproval = await reload("reload after approval");
  if (!afterApproval) {
    return;
  }
  if (!record(evaluateApprovedTurn({ messages: afterApproval, pending }))) {
    return;
  }
  const previousAssistantId = lastAssistantOf(afterApproval)?.id ?? "";

  const followUp = await sendTurn(
    request,
    "POST /v1/chat/ (turn 2)",
    buildUserTurnBody({
      runId: Bun.randomUUIDv7(),
      text: SMOKE_FOLLOW_UP_PROMPT,
      threadId,
    }),
  );
  if (!record(followUp)) {
    return;
  }

  const afterFollowUp = await reload("reload after turn 2");
  if (!afterFollowUp) {
    return;
  }
  record(
    evaluateFollowUpTurn({ messages: afterFollowUp, previousAssistantId }),
  );
};

/**
 * The whole journey. Stops at the first failed step, since each step builds on
 * the previous one, then deletes the thread and the AI config whatever
 * happened; returns every check it ran.
 */
export const runAIChatJourney = async ({
  apiKey,
  refreshSession,
  request,
}: {
  apiKey: string;
  /** Re-authenticates `request`, so cleanup does not depend on the journey
   *  finishing inside one session's lifetime. */
  refreshSession: () => Promise<void>;
  request: SmokeRequest;
}): Promise<SmokeCheck[]> => {
  const checks: SmokeCheck[] = [];
  const threadId = createSafeId<"chatThread">();
  const created = { thread: false };
  try {
    await runJourneySteps({ apiKey, checks, created, request, threadId });
  } catch (error) {
    checks.push({
      name: "AI chat journey",
      ok: false,
      detail: `aborted: ${describeError(error)}`,
    });
  } finally {
    try {
      await refreshSession();
    } catch (error) {
      // Cleanup still runs on the journey's session, which may yet be valid.
      checks.push({
        name: "cleanup: refresh smoke session",
        ok: false,
        detail: describeError(error),
      });
    }
    if (created.thread) {
      checks.push(
        await cleanUp(
          request,
          "cleanup: DELETE /v1/chat/threads/:threadId",
          `/v1/chat/threads/${threadId}`,
        ),
      );
    }
    checks.push(
      await cleanUp(
        request,
        "cleanup: DELETE /v1/organization-settings/ai-config",
        "/v1/organization-settings/ai-config",
      ),
    );
  }
  return checks;
};
