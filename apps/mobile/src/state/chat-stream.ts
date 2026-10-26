import { Result } from "better-result";
import * as v from "valibot";

import { CHAT_TURN_ID_HEADER } from "@stll/api-contract";

import { fetchWithTimeout } from "@/connection/http";
import type { Fetch } from "@/connection/http";
import type { AccessTokenSource } from "@/connection/session";
import {
  ApiRequestError,
  requestApi,
  withAccessToken,
} from "@/state/api-request";
import type { ApiError } from "@/state/api-request";
import type { ChatEntry } from "@/state/chat-messages";

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
 * (tool arguments and results, snapshots, custom progress) passes as
 * `ignored`, so an event this build has never seen does not end the stream.
 */
const chatEventSchema = v.union([
  v.object({
    type: v.literal("TEXT_MESSAGE_START"),
    messageId: v.string(),
  }),
  v.object({ type: v.literal("TEXT_MESSAGE_CONTENT"), delta: v.string() }),
  v.object({ type: v.literal("TOOL_CALL_START"), toolCallName: v.string() }),
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
 * for input only the web app can give (an approval or a question), or failed.
 */
export type AnswerStatus =
  "streaming" | "finished" | "stopped" | "needs-input" | "failed";

/** An answer as it arrives: its text segments, the tools it used, and where it stands. */
export type StreamedAnswer = {
  readonly messageId: string | undefined;
  readonly segments: readonly string[];
  readonly tools: readonly string[];
  readonly status: AnswerStatus;
};

export const EMPTY_ANSWER: StreamedAnswer = {
  messageId: undefined,
  segments: [],
  tools: [],
  status: "streaming",
};

/**
 * One event applied to the answer. Each text segment starts its own
 * message event, with the tools the model ran between them; the segments
 * join the way a stored message's text parts do.
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
        segments: [...answer.segments, ""],
      };
    }
    case "TEXT_MESSAGE_CONTENT": {
      const segments =
        answer.segments.length === 0 ? [""] : [...answer.segments];
      segments[segments.length - 1] = `${segments.at(-1) ?? ""}${event.delta}`;
      return { ...answer, segments };
    }
    case "TOOL_CALL_START": {
      return { ...answer, tools: [...answer.tools, event.toolCallName] };
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

/** The answer drawn as a thread entry, so it renders like a stored one. */
export const answerEntry = (
  answer: StreamedAnswer,
  createdAt: string,
): ChatEntry => ({
  id: answer.messageId ?? "streaming-answer",
  role: "assistant",
  createdAt,
  text: answer.segments
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "")
    .join("\n\n"),
  tools: answer.tools,
});

/**
 * The body `POST /v1/chat` takes: an AG-UI run envelope whose forwarded
 * props carry the message, repeated as `data`, and named again in
 * `messages`; the server refuses an envelope whose copies disagree. The
 * phone redacts nothing itself, so the text goes as written.
 */
export const chatSendBody = ({
  messageId,
  runId,
  text,
  threadId,
}: {
  readonly messageId: string;
  readonly runId: string;
  readonly text: string;
  readonly threadId: string;
}) => {
  const forwarded = {
    threadId,
    runId,
    sendMode: "rawOverride",
    message: {
      id: messageId,
      role: "user",
      parts: [{ type: "text", content: text }],
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

/** Waiting longer than this for a run to answer means the connection is gone. */
const STREAM_CONNECT_TIMEOUT_MS = 20_000;

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
}): Promise<Result<StreamEnd, ApiError>> => {
  const url = `${source.session().serverUrl}${path}`;
  return await withAccessToken(source, async (token) => {
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
    };
    signal.addEventListener("abort", abort);
    const connectTimer = setTimeout(abort, STREAM_CONNECT_TIMEOUT_MS);
    let lastId = lastEventId;
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
};

const turnPath = (threadId: string, turnId: string) =>
  `/v1/chat/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}`;

/** Sends one message and streams the answer to it. */
export const sendChatMessage = async ({
  fetch,
  messageId,
  onEvent,
  onTurn,
  runId,
  signal,
  source,
  text,
  threadId,
}: {
  readonly fetch: StreamFetch;
  readonly messageId: string;
  readonly onEvent: (event: ChatEvent) => void;
  readonly onTurn: (turnId: string) => void;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly source: AccessTokenSource;
  readonly text: string;
  readonly threadId: string;
}): Promise<Result<StreamEnd, ApiError>> =>
  await readChatStream({
    body: JSON.stringify(chatSendBody({ messageId, runId, text, threadId })),
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
  onEvent,
  signal,
  source,
  threadId,
  turnId,
}: {
  readonly fetch: StreamFetch;
  readonly lastEventId: string | undefined;
  readonly onEvent: (event: ChatEvent) => void;
  readonly signal: AbortSignal;
  readonly source: AccessTokenSource;
  readonly threadId: string;
  readonly turnId: string;
}): Promise<Result<StreamEnd, ApiError>> =>
  await readChatStream({
    fetch,
    lastEventId: lastEventId ?? "-1",
    method: "GET",
    onEvent,
    path: `${turnPath(threadId, turnId)}/join`,
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
  source,
  threadId,
  turnId,
}: {
  readonly fetch: Fetch;
  readonly source: AccessTokenSource;
  readonly threadId: string;
  readonly turnId: string;
}): Promise<Result<TurnProbe, ApiError>> =>
  await Result.gen(async function* () {
    const probe = yield* Result.await(
      requestApi({
        fetch,
        path: `${turnPath(threadId, turnId)}/resume`,
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
  const url = `${source.session().serverUrl}${turnPath(threadId, turnId)}/cancel`;
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
