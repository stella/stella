import { EventType } from "@tanstack/ai";
import type { AnyTextAdapter, StreamChunk } from "@tanstack/ai";
import {
  toRunErrorPayload,
  toRunErrorRawEvent,
} from "@tanstack/ai/adapter-internals";
import { Result } from "better-result";

import { Temporal } from "@stll/time";

// One owner for what every provider adapter's stream promises the rest of
// the service: it ends in exactly one terminal event (`RUN_FINISHED` or
// `RUN_ERROR`), last, and never by throwing. Adapters differ at the edges:
// some end a stream that stopped early with no event at all, some throw after
// their `RUN_ERROR`, some throw instead of reporting. Every adapter the model
// factory builds goes through here, so a reader never meets those edges.

/** The code of the run error a stream that ended early reports. */
export const INCOMPLETE_STREAM_CODE = "stream_incomplete";

const isTerminal = (chunk: StreamChunk): boolean =>
  chunk.type === EventType.RUN_FINISHED || chunk.type === EventType.RUN_ERROR;

const runError = (
  model: string,
  error: { code?: string | undefined; message: string },
  rawEvent?: unknown,
): StreamChunk => ({
  type: EventType.RUN_ERROR,
  model,
  timestamp: Temporal.Now.instant().epochMilliseconds,
  message: error.message,
  ...(error.code === undefined ? {} : { code: error.code }),
  ...(rawEvent === undefined ? {} : { rawEvent }),
  error: {
    message: error.message,
    ...(error.code === undefined ? {} : { code: error.code }),
  },
});

type RunErrorChunk = Extract<StreamChunk, { type: EventType.RUN_ERROR }>;
type RunFinishedChunk = Extract<StreamChunk, { type: EventType.RUN_FINISHED }>;

/**
 * The run error code of a response the model stopped writing because it
 * reached the output ceiling the request set (Anthropic, Gemini).
 */
const TRUNCATED_AT_OUTPUT_CEILING_CODE = "max_tokens";
/**
 * OpenAI's Responses adapter reports a response that ended incomplete with
 * this code, and the reason it ended as the message.
 */
const INCOMPLETE_RESPONSE_CODE = "incomplete";
const OUTPUT_CEILING_REASON = "max_output_tokens";

const isOutputCeilingStop = (chunk: RunErrorChunk): boolean =>
  chunk.code === TRUNCATED_AT_OUTPUT_CEILING_CODE ||
  (chunk.code === INCOMPLETE_RESPONSE_CODE &&
    chunk.message === OUTPUT_CEILING_REASON);

/**
 * A response cut off at the output ceiling, read as a `length` finish.
 *
 * Several adapters report that stop as a `RUN_ERROR` by design, where they
 * report every other one as a `RUN_FINISHED`. The engine, middleware and
 * caller must agree that the run reached the ceiling rather than recording a
 * failure while keeping its partial text, so the stop is read as `length`
 * before anything else sees it. The adapters' own events are left as they
 * are: the pass keys on the event, not on who reported it, so an adapter that
 * already ends a ceiling stop with `RUN_FINISHED` passes through untouched.
 *
 * The finish is held until the stream ends. An adapter that reports the stop
 * and then finishes anyway (Gemini) has its closing events pass in order, and
 * its trailing `RUN_FINISHED` gives the finish the usage the stop lacked.
 *
 * @yields Every chunk of the run, with a ceiling stop read as `length`.
 */
export const readOutputCeilingStopAsLength = async function* (
  chunks: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  let runIdentity: { runId: string; threadId: string } | undefined;
  let held: RunFinishedChunk | undefined;
  for await (const chunk of chunks) {
    if (chunk.type === EventType.RUN_STARTED) {
      runIdentity = { runId: chunk.runId, threadId: chunk.threadId };
    }
    if (
      chunk.type === EventType.RUN_ERROR &&
      held === undefined &&
      runIdentity !== undefined &&
      isOutputCeilingStop(chunk)
    ) {
      held = {
        type: EventType.RUN_FINISHED,
        finishReason: "length",
        runId: runIdentity.runId,
        threadId: runIdentity.threadId,
        ...(chunk.metadata === undefined ? {} : { metadata: chunk.metadata }),
        ...(chunk.model === undefined ? {} : { model: chunk.model }),
        ...(chunk.timestamp === undefined
          ? {}
          : { timestamp: chunk.timestamp }),
        ...(chunk.usage === undefined ? {} : { usage: chunk.usage }),
      };
      continue;
    }
    if (held !== undefined && chunk.type === EventType.RUN_FINISHED) {
      if (held.usage === undefined && chunk.usage !== undefined) {
        held = { ...held, usage: chunk.usage };
      }
      continue;
    }
    yield chunk;
  }
  if (held !== undefined) {
    yield held;
  }
};

type ChatStreamOptions = Parameters<AnyTextAdapter["chatStream"]>[0];

async function* withOneTerminalEvent(
  chunks: AsyncIterable<StreamChunk>,
  options: ChatStreamOptions,
): AsyncIterable<StreamChunk> {
  const signal = options.request?.signal ?? undefined;
  const iterator = chunks[Symbol.asyncIterator]();
  let ended = false;
  // Set once the adapter's stream has finished on its own, by ending or by
  // throwing; any other exit (the reader stopped early) closes it here.
  let settled = false;
  try {
    for (;;) {
      const step = await Result.tryPromise(async () => await iterator.next());
      if (Result.isError(step)) {
        settled = true;
        // A throw after the run ended, or once it was cancelled, adds nothing.
        const error = step.error.cause;
        if (!ended && signal?.aborted !== true) {
          yield runError(
            options.model,
            toRunErrorPayload(error, "The provider stream failed"),
            toRunErrorRawEvent(error),
          );
        }
        return;
      }
      if (step.value.done === true) {
        settled = true;
        break;
      }
      // Nothing follows the terminal event; the rest is still read, so the
      // adapter finishes its own stream.
      if (!ended) {
        yield step.value.value;
        ended = isTerminal(step.value.value);
      }
    }
  } finally {
    if (!settled) {
      const closed = await Result.tryPromise(
        async () => await iterator.return?.(),
      );
      // Best effort: the reader already stopped and the run has its outcome,
      // so a close that fails has no one left to tell.
      closed.match({ err: () => undefined, ok: () => undefined });
    }
  }
  // A cancelled run ends where the cancel left it; any other run that stops
  // before its terminal event did not finish.
  if (!ended && signal?.aborted !== true) {
    yield runError(options.model, {
      code: INCOMPLETE_STREAM_CODE,
      message: "The provider stream ended before the response finished.",
    });
  }
}

/**
 * `adapter` with its chat stream held to the contract above. Every other
 * member is the adapter's own, its methods bound to it, so class state
 * (private fields included) keeps working.
 */
export const withProviderStreamContract = (
  adapter: AnyTextAdapter,
): AnyTextAdapter => {
  const chatStream: AnyTextAdapter["chatStream"] = (options) =>
    withOneTerminalEvent(
      readOutputCeilingStopAsLength(adapter.chatStream(options)),
      options,
    );
  return new Proxy(adapter, {
    get: (target, key) => {
      if (key === "chatStream") {
        return chatStream;
      }
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") {
        return value;
      }
      const bound: unknown = value.bind(target);
      return bound;
    },
  });
};
