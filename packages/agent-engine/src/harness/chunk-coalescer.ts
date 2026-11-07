import { EventType, type StreamChunk } from "@tanstack/ai";

/**
 * Merges the text and reasoning deltas a harness streams before they become
 * stored run messages. A harness reports a delta every few tokens, and each
 * chunk the sidecar sends is one message the API stores against the run's
 * message and byte caps, so a long answer sent delta by delta can end its run.
 *
 * Consecutive content chunks of the same message merge into one; every other
 * chunk, and a content chunk of another message, sends what is held first and
 * then passes unchanged. Concatenated deltas fold to the same text, so the
 * stored and reloaded message equals the one streamed delta by delta.
 */

/**
 * How long a delta waits for the next ones. At 150 ms a streaming answer
 * still updates several times a second, which reads as live, while the
 * dozens of deltas a harness sends each second become at most about seven
 * stored messages.
 */
export const CHUNK_COALESCE_WINDOW_MS = 150;

/**
 * The UTF-8 bytes of delta one merged chunk holds before it is sent: a small
 * fraction of the runner's 4 MiB frame, so a burst never nears it. A single
 * delta above it passes as it came.
 */
const CHUNK_COALESCE_MAX_DELTA_BYTES = 64 * 1024;

type ContentChunk = Extract<
  StreamChunk,
  { type: EventType.TEXT_MESSAGE_CONTENT | EventType.REASONING_MESSAGE_CONTENT }
>;

const isContentChunk = (chunk: StreamChunk): chunk is ContentChunk =>
  chunk.type === EventType.TEXT_MESSAGE_CONTENT ||
  chunk.type === EventType.REASONING_MESSAGE_CONTENT;

/**
 * What two content chunks must share to merge: everything but the delta and
 * the time, so the merged chunk loses nothing either of them carried.
 */
const mergeKey = (chunk: ContentChunk) => {
  const { delta: _delta, timestamp: _timestamp, ...rest } = chunk;
  return JSON.stringify(rest);
};

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).byteLength;

/** Schedules `flush` after `delayMs` and returns what cancels it. */
export type CoalesceSchedule = (
  flush: () => void,
  delayMs: number,
) => () => void;

export const scheduleTimeout: CoalesceSchedule = (flush, delayMs) => {
  const timer = setTimeout(flush, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

export type ChunkCoalescerOptions = {
  /** Sends one chunk on; called in the order the chunks arrived. */
  emit: (chunk: StreamChunk) => void;
  schedule: CoalesceSchedule;
  windowMs?: number;
  maxDeltaBytes?: number;
};

export type ChunkCoalescer = {
  push: (chunk: StreamChunk) => void;
  /** Send whatever is held now; the stream's end calls it. */
  flush: () => void;
};

type Held = {
  /** The first chunk merged, whose fields and time the merged chunk keeps. */
  first: ContentChunk;
  key: string;
  deltas: string[];
  bytes: number;
  cancel: () => void;
};

export const createChunkCoalescer = ({
  emit,
  schedule,
  windowMs = CHUNK_COALESCE_WINDOW_MS,
  maxDeltaBytes = CHUNK_COALESCE_MAX_DELTA_BYTES,
}: ChunkCoalescerOptions): ChunkCoalescer => {
  let held: Held | null = null;

  const flush = () => {
    if (held === null) {
      return;
    }
    const { first, deltas, cancel } = held;
    held = null;
    cancel();
    emit(deltas.length === 1 ? first : { ...first, delta: deltas.join("") });
  };

  const push = (chunk: StreamChunk) => {
    if (!isContentChunk(chunk)) {
      flush();
      emit(chunk);
      return;
    }
    const key = mergeKey(chunk);
    const bytes = utf8Length(chunk.delta);
    if (
      held !== null &&
      (held.key !== key || held.bytes + bytes > maxDeltaBytes)
    ) {
      flush();
    }
    if (held === null) {
      // The window runs from the first delta held, so a steady stream of
      // deltas still goes out on time.
      held = {
        first: chunk,
        key,
        deltas: [chunk.delta],
        bytes,
        cancel: schedule(flush, windowMs),
      };
    } else {
      held.deltas.push(chunk.delta);
      held.bytes += bytes;
    }
    if (held.bytes >= maxDeltaBytes) {
      flush();
    }
  };

  return { push, flush };
};
