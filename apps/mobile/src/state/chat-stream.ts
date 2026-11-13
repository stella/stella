import { Result } from "better-result";
import * as v from "valibot";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";
import { isChatLocalRunToolName } from "@stll/api-contract/chat-local-run-tool";

import { SignedOutError } from "@/connection/errors";
import { fetchWithTimeout } from "@/connection/http";
import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import {
  ApiRequestError,
  requestApi,
  withAccessToken,
} from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import { answerBlocks, messageText } from "@/state/chat-answer";
import { attachmentParts } from "@/state/chat-attachments";
import type { ReadyFile } from "@/state/chat-attachments";
import type { ChatEntry } from "@/state/chat-messages";
import type { LocalRunTarget } from "@/state/chat-pending-input";

/** One server-sent event: the id it carried, if any, and its data lines joined. */
type SseEvent = {
  readonly id: string | undefined;
  readonly data: string;
};

/**
 * Reads server-sent events out of a body that arrives in arbitrary pieces.
 * A line split across two chunks, or a CRLF split between them, waits for
 * the rest; comment lines (the server's heartbeat) and fields this client
 * does not use are skipped.
 */
export const createSseParser = () => {
  let pending = "";
  let id: string | undefined = undefined;
  let data: string[] = [];

  return (chunk: string): SseEvent[] => {
    pending += chunk;
    const events: SseEvent[] = [];
    // A trailing CR may be the first half of a CRLF, so it waits for the
    // next chunk; the last piece of the split is a line still arriving.
    const heldCr = pending.endsWith("\r");
    const lines = (heldCr ? pending.slice(0, -1) : pending).split(
      /\r\n|\n|\r/u,
    );
    pending = `${lines.pop() ?? ""}${heldCr ? "\r" : ""}`;
    for (const line of lines) {
      if (line === "") {
        if (data.length > 0) {
          events.push({ id, data: data.join("\n") });
          data = [];
        }
        continue;
      }
      if (line.startsWith(":")) {
        continue;
      }
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const rawValue = colon === -1 ? "" : line.slice(colon + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "data") {
        data.push(value);
      } else if (field === "id") {
        id = value;
      }
    }
    return events;
  };
};

/**
 * The AG-UI events an answer is drawn from. Everything else the run sends
 * (snapshots, custom progress) passes as `ignored`, so an event this build
 * has never seen does not end the stream.
 */
const chatEventSchema = v.union([
  v.object({
    type: v.literal("TEXT_MESSAGE_START"),
    messageId: v.string(),
  }),
  v.object({ type: v.literal("TEXT_MESSAGE_CONTENT"), delta: v.string() }),
  v.object({ type: v.literal("REASONING_MESSAGE_START") }),
  v.object({
    type: v.literal("REASONING_MESSAGE_CONTENT"),
    delta: v.string(),
  }),
  v.object({
    type: v.literal("TOOL_CALL_START"),
    toolCallId: v.string(),
    toolCallName: v.string(),
  }),
  v.object({
    type: v.literal("TOOL_CALL_ARGS"),
    toolCallId: v.string(),
    delta: v.string(),
  }),
  v.object({ type: v.literal("TOOL_CALL_END"), toolCallId: v.string() }),
  v.object({
    type: v.literal("TOOL_CALL_RESULT"),
    toolCallId: v.string(),
    content: v.optional(v.string()),
    // `output-error` for a call that failed or was cancelled, which the
    // stored message keeps as an errored call.
    state: v.optional(v.string()),
  }),
  v.object({
    type: v.literal("RUN_FINISHED"),
    outcome: v.optional(v.looseObject({ type: v.string() })),
  }),
  v.object({ type: v.literal("RUN_ERROR") }),
]);

export type ChatEvent = v.InferOutput<typeof chatEventSchema>;

/** An event's data, or undefined when it is not one an answer is drawn from. */
export const parseChatEvent = (data: string): ChatEvent | undefined => {
  const json = Result.try(() => JSON.parse(data) as unknown);
  if (Result.isError(json)) {
    return undefined;
  }
  const parsed = v.safeParse(chatEventSchema, json.value);
  return parsed.success ? parsed.output : undefined;
};

/**
 * How an answer ended: still arriving, done, stopped by the person, waiting
 * for the person's input (an approval or a question; the stored thread says
 * which), or failed.
 */
export type AnswerStatus =
  "streaming" | "finished" | "stopped" | "needs-input" | "failed";

/**
 * A part of an answer as it arrives, in the shape of a stored message's
 * part, so both draw through `answerBlocks`: text, reasoning, and tool
 * calls, each complete once its result came back, or errored when the
 * result says the call failed or was cancelled.
 */
type StreamedPart =
  | { readonly type: "text" | "thinking"; readonly content: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly state: "input-streaming" | "complete" | "error";
      /**
       * What a step a coding agent took on the person's computer was
       * given: its arguments as they arrive, then, once whole, read as the
       * input a stored call keeps. No other call's arguments are kept.
       */
      readonly args?: string;
      readonly input?: unknown;
      readonly output?: unknown;
    };

/** An answer as it arrives: its parts in order, and where it stands. */
export type StreamedAnswer = {
  readonly messageId: string | undefined;
  readonly parts: readonly StreamedPart[];
  readonly status: AnswerStatus;
};

export const EMPTY_ANSWER: StreamedAnswer = {
  messageId: undefined,
  parts: [],
  status: "streaming",
};

/**
 * The parts with `delta` added to the last one of `type`'s kind, or to a
 * new one when another kind of part came since.
 */
const appendDelta = (
  parts: readonly StreamedPart[],
  type: "text" | "thinking",
  delta: string,
): StreamedPart[] => {
  const last = parts.at(-1);
  return last?.type === type
    ? [...parts.slice(0, -1), { type, content: `${last.content}${delta}` }]
    : [...parts, { type, content: delta }];
};

/**
 * A tool result's content, or a call's whole arguments: the JSON it
 * carries, or the text as it came.
 */
const resultOutput = (content: string | undefined): unknown => {
  if (content === undefined) {
    return undefined;
  }
  const parsed = Result.try(() => JSON.parse(content) as unknown);
  return Result.isOk(parsed) ? parsed.value : content;
};

/**
 * One event applied to the answer. Each text and each stretch of reasoning
 * grows as it streams; a tool call runs from its start until its result
 * comes back. The parts stay in the order they arrived, as a stored
 * message keeps them.
 */
export const applyChatEvent = (
  answer: StreamedAnswer,
  event: ChatEvent,
): StreamedAnswer => {
  switch (event.type) {
    case "TEXT_MESSAGE_START": {
      return {
        ...answer,
        messageId: answer.messageId ?? event.messageId,
        parts: [...answer.parts, { type: "text", content: "" }],
      };
    }
    case "TEXT_MESSAGE_CONTENT": {
      return {
        ...answer,
        parts: appendDelta(answer.parts, "text", event.delta),
      };
    }
    case "REASONING_MESSAGE_START": {
      return {
        ...answer,
        parts: [...answer.parts, { type: "thinking", content: "" }],
      };
    }
    case "REASONING_MESSAGE_CONTENT": {
      return {
        ...answer,
        parts: appendDelta(answer.parts, "thinking", event.delta),
      };
    }
    case "TOOL_CALL_START": {
      return {
        ...answer,
        parts: [
          ...answer.parts,
          {
            type: "tool-call",
            id: event.toolCallId,
            name: event.toolCallName,
            state: "input-streaming",
          },
        ],
      };
    }
    case "TOOL_CALL_ARGS": {
      return {
        ...answer,
        parts: answer.parts.map((part): StreamedPart =>
          part.type === "tool-call" &&
          part.id === event.toolCallId &&
          isChatLocalRunToolName(part.name)
            ? { ...part, args: `${part.args ?? ""}${event.delta}` }
            : part,
        ),
      };
    }
    case "TOOL_CALL_END": {
      return {
        ...answer,
        parts: answer.parts.map((part): StreamedPart => {
          if (
            part.type !== "tool-call" ||
            part.id !== event.toolCallId ||
            part.args === undefined
          ) {
            return part;
          }
          const { args, ...call } = part;
          return { ...call, input: resultOutput(args) };
        }),
      };
    }
    case "TOOL_CALL_RESULT": {
      return {
        ...answer,
        parts: answer.parts.map((part): StreamedPart =>
          part.type === "tool-call" && part.id === event.toolCallId
            ? {
                ...part,
                state: event.state === "output-error" ? "error" : "complete",
                output: resultOutput(event.content),
              }
            : part,
        ),
      };
    }
    case "RUN_FINISHED": {
      return { ...answer, status: finishedStatus(event.outcome?.type) };
    }
    case "RUN_ERROR": {
      break;
    }
  }
  return { ...answer, status: "failed" };
};

function finishedStatus(outcome: string | undefined): AnswerStatus {
  if (outcome === "cancelled") {
    return "stopped";
  }
  if (outcome === "interrupt") {
    return "needs-input";
  }
  return "finished";
}

/**
 * The answer's parts as they stand once it ended. A call still open when
 * the run failed or was stopped never finished: it is cut off, errored with
 * no result as the stored message keeps it, so its step and the subagent it
 * belongs to do not read as still under way. A turn that waits for the
 * person keeps its open call: the stored thread, read next, says what for.
 */
const endedParts = ({
  parts,
  status,
}: StreamedAnswer): readonly StreamedPart[] =>
  status === "failed" || status === "stopped"
    ? parts.map((part): StreamedPart =>
        part.type === "tool-call" && part.state === "input-streaming"
          ? {
              type: "tool-call",
              id: part.id,
              name: part.name,
              state: "error",
              ...(part.input === undefined ? {} : { input: part.input }),
            }
          : part,
      )
    : parts;

/** The answer drawn as a thread entry, so it renders like a stored one. */
export const answerEntry = (
  answer: StreamedAnswer,
  createdAt: string,
): ChatEntry => ({
  id: answer.messageId ?? "streaming-answer",
  role: "assistant",
  createdAt,
  text: messageText(answer.parts),
  blocks: answerBlocks(endedParts(answer)),
  files: [],
  // The stored answer names its drafts once the thread is read again.
  drafts: [],
});

/**
 * The body `POST /v1/chat` takes: an AG-UI run envelope whose forwarded
 * props carry the message, repeated as `data`, and named again in
 * `messages`; the server refuses an envelope whose copies disagree. The
 * phone redacts nothing itself, so the text goes as written; a thread that
 * has sent anonymized text asks the server to anonymize this message too,
 * so continuing it from the phone does not undo its protection. Attached
 * files ride in the message after its text, as the web sends them.
 */
export const chatSendBody = ({
  anonymized,
  files = [],
  matterId,
  messageId,
  runId,
  text,
  threadId,
}: {
  /** The thread has sent anonymized text before. */
  readonly anonymized: boolean;
  readonly files?: readonly ReadyFile[];
  /** The thread's matter; the server refuses a matter's thread sent to as global. */
  readonly matterId: string | undefined;
  readonly messageId: string;
  readonly runId: string;
  readonly text: string;
  readonly threadId: string;
}) => {
  const forwarded = {
    ...turnScope({ anonymized, matterId, runId, threadId }),
    message: {
      id: messageId,
      role: "user",
      parts: [
        ...(text === "" ? [] : [{ type: "text", content: text }]),
        ...attachmentParts(files),
      ],
    },
  };
  return {
    threadId,
    runId,
    state: {},
    messages: [{ id: messageId, role: "user", content: text }],
    tools: [],
    context: [],
    forwardedProps: forwarded,
    data: forwarded,
  };
};

/**
 * What every request about a thread's turn names: the thread, the new run,
 * the thread's matter, and how its text is sent.
 */
const turnScope = ({
  anonymized,
  matterId,
  runId,
  threadId,
}: {
  readonly anonymized: boolean;
  readonly matterId: string | undefined;
  readonly runId: string;
  readonly threadId: string;
}) => ({
  threadId,
  runId,
  ...(matterId === undefined ? {} : { workspaceId: matterId }),
  sendMode: anonymized ? "anonymized" : "rawOverride",
});

/**
 * A continuation: the answer to what a paused turn waits for, which resumes
 * it in a new run. The paused assistant message goes back with the calls the
 * answer settles, the paused run is named as the parent, and each interrupt
 * gets its resume item, at the top level and again in the forwarded props,
 * as the web sends one. A turn a coding agent on the person's computer runs
 * names the thread's local run target, so the server hands the answer to the
 * computer that paused.
 */
export const chatContinueBody = ({
  anonymized,
  continuation: { messageId, parentRunId, parts, resume },
  matterId,
  runId,
  runTarget,
  threadId,
}: {
  readonly anonymized: boolean;
  readonly continuation: ChatContinuation;
  readonly matterId: string | undefined;
  readonly runId: string;
  readonly runTarget: LocalRunTarget | undefined;
  readonly threadId: string;
}) => {
  const forwarded = {
    ...turnScope({ anonymized, matterId, runId, threadId }),
    ...(runTarget === undefined ? {} : { runTarget }),
    message: { id: messageId, role: "assistant", parts },
    parentRunId,
    resume,
  };
  return {
    threadId,
    runId,
    state: {},
    messages: [{ id: messageId, role: "assistant" }],
    tools: [],
    context: [],
    forwardedProps: forwarded,
    data: forwarded,
    parentRunId,
    resume,
  };
};

/** The paused message an answer continues, and what the answer carries. */
type ChatContinuation = {
  readonly messageId: string;
  readonly parentRunId: string;
  readonly parts: readonly unknown[];
  readonly resume: readonly unknown[];
};

/**
 * The part of a streaming fetch this module reads. The platform fetch in
 * React Native buffers the whole body, so the app passes Expo's, which
 * streams it; tests pass Bun's.
 */
export type StreamFetch = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get: (name: string) => string | null };
  readonly body: {
    getReader: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array | undefined }>;
      cancel: () => Promise<void>;
    };
  } | null;
}>;

/** A stream ended: its last event id, so a dropped connection can pick up after it. */
export type StreamEnd = { readonly lastEventId: string | undefined };

/**
 * A stream broke: why, and the last event id read before it did. The
 * events up to it are already drawn, so a rejoin must pick up after it
 * rather than replay them into the answer a second time.
 */
export type StreamBreak = StreamEnd & { readonly error: ApiError };

/** Waiting longer than this for a run to answer means the connection is gone. */
const STREAM_CONNECT_TIMEOUT_MS = 20_000;

/**
 * The slowest upload a send still waits for, in bytes per millisecond
 * (about 400 kbit/s), and the longest it waits at all: as long as a signed
 * storage upload lives.
 */
const SLOW_UPLOAD_BYTES_PER_MS = 50;
const STREAM_UPLOAD_TIMEOUT_MS = 5 * 60_000;

/**
 * How long a request waits for the run to answer. A message with files
 * carries them in its body, which must go up first; it gets the time a slow
 * phone network takes to send it, on top of the usual wait.
 */
export const streamConnectTimeout = (bodyLength: number): number =>
  Math.min(
    STREAM_CONNECT_TIMEOUT_MS +
      Math.ceil(bodyLength / SLOW_UPLOAD_BYTES_PER_MS),
    STREAM_UPLOAD_TIMEOUT_MS,
  );

/**
 * Opens one SSE request and hands each answer event to `onEvent` as it
 * arrives. The turn id the server names in its response reaches `onTurn`
 * before any event. Aborting `signal` ends the read without an error.
 */
const readChatStream = async ({
  body,
  fetch,
  lastEventId,
  method,
  onEvent,
  onTurn,
  path,
  signal,
  source,
}: {
  readonly body?: string;
  readonly fetch: StreamFetch;
  readonly lastEventId?: string | undefined;
  readonly method: "GET" | "POST";
  readonly onEvent: (event: ChatEvent) => void;
  readonly onTurn?: (turnId: string) => void;
  readonly path: string;
  readonly signal: AbortSignal;
  readonly source: AccessTokenSource;
}): Promise<Result<StreamEnd, StreamBreak>> => {
  const session = source.session();
  if (session === undefined) {
    return Result.err({
      lastEventId,
      error: new SignedOutError({
        message: "The session is no longer current",
      }),
    });
  }
  const url = `${session.serverUrl}${path}`;
  // Kept outside the request so a stream that breaks part way still reports
  // the last event it delivered.
  let lastId = lastEventId;
  const ended = await withAccessToken(source, async (token) => {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal.addEventListener("abort", abort);
    const connectTimer = setTimeout(
      abort,
      streamConnectTimeout(body?.length ?? 0),
    );
    const read = await Result.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          method,
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...(lastEventId === undefined
              ? {}
              : { "Last-Event-ID": lastEventId }),
          },
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        });
        clearTimeout(connectTimer);
        if (!response.ok || response.body === null) {
          return response.status;
        }
        const turnId = response.headers.get(CHAT_TURN_ID_HEADER);
        if (turnId !== null) {
          onTurn?.(turnId);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parse = createSseParser();
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          for (const event of parse(
            decoder.decode(chunk.value, { stream: true }),
          )) {
            lastId = event.id ?? lastId;
            const parsed = parseChatEvent(event.data);
            if (parsed !== undefined) {
              onEvent(parsed);
            }
          }
        }
        return response.status;
      },
      catch: (cause) =>
        new ApiRequestError({ message: `The stream from ${url} broke`, cause }),
    });
    clearTimeout(connectTimer);
    signal.removeEventListener("abort", abort);
    if (Result.isError(read)) {
      return signal.aborted
        ? Result.ok({ lastEventId: lastId })
        : Result.err(read.error);
    }
    const status = read.value;
    if (status < 200 || status >= 300) {
      return Result.err(
        new ApiRequestError({
          message: `The request to ${url} responded ${status}`,
          status,
        }),
      );
    }
    return Result.ok({ lastEventId: lastId });
  });
  return ended.mapError((error) => ({ error, lastEventId: lastId }));
};

const turnPath = (threadId: string, turnId: string) =>
  `/v1/chat/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}`;

/** A matter's thread names its matter, or the server refuses it as out of scope. */
const scopeQuery = (matterId: string | undefined) =>
  matterId === undefined ? "" : `?workspaceId=${encodeURIComponent(matterId)}`;

/** Sends one message, with any files attached to it, and streams the answer to it. */
export const sendChatMessage = async ({
  anonymized,
  fetch,
  files = [],
  matterId,
  messageId,
  onEvent,
  onTurn,
  runId,
  signal,
  source,
  text,
  threadId,
}: {
  readonly anonymized: boolean;
  readonly fetch: StreamFetch;
  readonly files?: readonly ReadyFile[];
  readonly matterId: string | undefined;
  readonly messageId: string;
  readonly onEvent: (event: ChatEvent) => void;
  readonly onTurn: (turnId: string) => void;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly source: AccessTokenSource;
  readonly text: string;
  readonly threadId: string;
}): Promise<Result<StreamEnd, StreamBreak>> =>
  await readChatStream({
    body: JSON.stringify(
      chatSendBody({
        anonymized,
        files,
        matterId,
        messageId,
        runId,
        text,
        threadId,
      }),
    ),
    fetch,
    method: "POST",
    onEvent,
    onTurn,
    path: "/v1/chat",
    signal,
    source,
  });

/**
 * Answers what a paused turn waits for and streams the answer's run, as a
 * send does: the server names the new turn before any event.
 */
export const continueChatTurn = async ({
  anonymized,
  continuation,
  fetch,
  matterId,
  onEvent,
  onTurn,
  runId,
  runTarget,
  signal,
  source,
  threadId,
}: {
  readonly anonymized: boolean;
  readonly continuation: ChatContinuation;
  readonly fetch: StreamFetch;
  readonly matterId: string | undefined;
  readonly onEvent: (event: ChatEvent) => void;
  readonly onTurn: (turnId: string) => void;
  readonly runId: string;
  readonly runTarget: LocalRunTarget | undefined;
  readonly signal: AbortSignal;
  readonly source: AccessTokenSource;
  readonly threadId: string;
}): Promise<Result<StreamEnd, StreamBreak>> =>
  await readChatStream({
    body: JSON.stringify(
      chatContinueBody({
        anonymized,
        continuation,
        matterId,
        runId,
        runTarget,
        threadId,
      }),
    ),
    fetch,
    method: "POST",
    onEvent,
    onTurn,
    path: "/v1/chat",
    signal,
    source,
  });

/**
 * Rejoins a running turn. With `lastEventId` it picks up after that event;
 * without, it replays the turn from its start.
 */
export const joinChatTurn = async ({
  fetch,
  lastEventId,
  matterId,
  onEvent,
  signal,
  source,
  threadId,
  turnId,
}: {
  readonly fetch: StreamFetch;
  readonly lastEventId: string | undefined;
  readonly matterId: string | undefined;
  readonly onEvent: (event: ChatEvent) => void;
  readonly signal: AbortSignal;
  readonly source: AccessTokenSource;
  readonly threadId: string;
  readonly turnId: string;
}): Promise<Result<StreamEnd, StreamBreak>> =>
  await readChatStream({
    fetch,
    lastEventId: lastEventId ?? "-1",
    method: "GET",
    onEvent,
    path: `${turnPath(threadId, turnId)}/join${scopeQuery(matterId)}`,
    signal,
    source,
  });

const turnProbeSchema = v.variant("type", [
  v.object({ type: v.literal("preparing") }),
  v.object({ type: v.literal("running") }),
  v.object({ type: v.literal("transcript") }),
]);

/**
 * Where a turn stands on the server: still being prepared, running (so it
 * can be joined), or over, its answer stored in the thread.
 */
type TurnProbe = v.InferOutput<typeof turnProbeSchema>["type"];

export const probeChatTurn = async ({
  fetch,
  matterId,
  source,
  threadId,
  turnId,
}: {
  readonly fetch: Fetch;
  readonly matterId: string | undefined;
  readonly source: AccessTokenSource;
  readonly threadId: string;
  readonly turnId: string;
}): Promise<Result<TurnProbe, ApiError>> =>
  await Result.gen(async function* () {
    const probe = yield* Result.await(
      requestApi({
        fetch,
        path: `${turnPath(threadId, turnId)}/resume${scopeQuery(matterId)}`,
        schema: turnProbeSchema,
        source,
      }),
    );
    return Result.ok(probe.type);
  });

/** Asks the server to stop a turn; the stream then ends with the run stopped. */
export const cancelChatTurn = async ({
  fetch,
  source,
  threadId,
  turnId,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly threadId: string;
  readonly turnId: string;
}): Promise<Result<void, ApiError>> => {
  const session = source.session();
  if (session === undefined) {
    return Result.err(
      new SignedOutError({ message: "The session is no longer current" }),
    );
  }
  const url = `${session.serverUrl}${turnPath(threadId, turnId)}/cancel`;
  return await withAccessToken(source, async (token) => {
    const answered = await Result.tryPromise({
      try: async () =>
        await fetchWithTimeout(fetch, url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }),
      catch: (cause) =>
        new ApiRequestError({ message: `The request to ${url} failed`, cause }),
    });
    if (Result.isError(answered)) {
      return Result.err(answered.error);
    }
    const { ok, status } = answered.value;
    return ok
      ? Result.ok(undefined)
      : Result.err(
          new ApiRequestError({
            message: `The request to ${url} responded ${status}`,
            status,
          }),
        );
  });
};
