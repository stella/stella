import { afterEach, describe, expect, jest, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import nodePath from "node:path";

import { SSE_HEARTBEAT_FRAME } from "@stll/api-contract/sse-heartbeat";

import { LIMITS } from "@/api/lib/limits";
import { sseResponse, withSseHeartbeat } from "@/api/lib/sse-heartbeat";

const decoder = new TextDecoder();
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

type ControlledSource = {
  cancelled: { reason: unknown; state: "cancelled" | "open" };
  stream: ReadableStream<Uint8Array>;
  write: (text: string) => void;
  end: () => void;
};

/** A source that produces only what a test tells it to, and records its cancel. */
const controlledSource = (): ControlledSource => {
  const cancelled: ControlledSource["cancelled"] = {
    reason: undefined,
    state: "open",
  };
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      source = controller;
    },
    cancel: (reason: unknown) => {
      cancelled.state = "cancelled";
      cancelled.reason = reason;
    },
  });
  return {
    cancelled,
    stream,
    write: (text) => source?.enqueue(encode(text)),
    end: () => source?.close(),
  };
};

type ChunkReader = {
  read: () => Promise<{ done: boolean; value?: Uint8Array | undefined }>;
};

/** Read one chunk, letting pending timers and the pull loop settle first. */
const readNext = async (reader: ChunkReader): Promise<string> => {
  const pending = reader.read();
  await Promise.resolve();
  const result = await pending;
  return result.done ? "<done>" : decoder.decode(result.value);
};

afterEach(() => {
  jest.useRealTimers();
});

describe("SSE heartbeat", () => {
  test("writes a comment frame for every interval the source stays silent", async () => {
    jest.useFakeTimers();
    const source = controlledSource();
    const reader = sseResponse(source.stream).body?.getReader();
    if (!reader) {
      throw new Error("Event-stream response carried no body");
    }

    const first = reader.read();
    await Promise.resolve();
    jest.advanceTimersByTime(LIMITS.sseHeartbeatMs);
    expect(decoder.decode((await first).value)).toBe(SSE_HEARTBEAT_FRAME);

    const second = reader.read();
    await Promise.resolve();
    jest.advanceTimersByTime(LIMITS.sseHeartbeatMs);
    expect(decoder.decode((await second).value)).toBe(SSE_HEARTBEAT_FRAME);
  });

  test("passes a producing source through unchanged and adds nothing", async () => {
    jest.useFakeTimers();
    const source = controlledSource();
    const reader = sseResponse(source.stream).body?.getReader();
    if (!reader) {
      throw new Error("Event-stream response carried no body");
    }

    const written: string[] = [];
    for (const frame of ["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"]) {
      source.write(frame);
      written.push(await readNext(reader));
      // Each chunk re-arms the timer, so the silence never adds up to one
      // interval however long the turn runs.
      jest.advanceTimersByTime(LIMITS.sseHeartbeatMs - 1);
    }

    expect(written).toEqual(["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"]);
  });

  test("stops writing once the source closes", async () => {
    jest.useFakeTimers();
    const source = controlledSource();
    const reader = sseResponse(source.stream).body?.getReader();
    if (!reader) {
      throw new Error("Event-stream response carried no body");
    }

    source.end();
    expect(await readNext(reader)).toBe("<done>");

    jest.advanceTimersByTime(LIMITS.sseHeartbeatMs * 10);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("cancel drops the timer and cancels the source", async () => {
    jest.useFakeTimers();
    const source = controlledSource();
    const reader = sseResponse(source.stream).body?.getReader();
    if (!reader) {
      throw new Error("Event-stream response carried no body");
    }

    await reader.cancel("client gone");

    expect(source.cancelled.state).toBe("cancelled");
    expect(source.cancelled.reason).toBe("client gone");
    jest.advanceTimersByTime(LIMITS.sseHeartbeatMs * 10);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("keeps the status and headers of a response built elsewhere", () => {
    const source = controlledSource();
    const wrapped = withSseHeartbeat(
      new Response(source.stream, {
        headers: { "content-type": "text/event-stream", "x-run": "run-1" },
        status: 200,
      }),
    );

    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
    expect(wrapped.headers.get("x-run")).toBe("run-1");
  });

  test("serves an event stream that no intermediary may cache or buffer", () => {
    const response = sseResponse(controlledSource().stream);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe(
      "no-cache, no-store, no-transform",
    );
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });
});

const API_SOURCE = nodePath.join(import.meta.dirname, "..");
const HEARTBEAT_MODULE = nodePath.join(API_SOURCE, "lib/sse-heartbeat.ts");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const TEST_FILE_PATTERN = /\.(?:test|spec)\.tsx?$/u;

const listSourceFiles = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = nodePath.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(path));
      continue;
    }
    if (
      !SOURCE_EXTENSIONS.has(nodePath.extname(entry.name)) ||
      TEST_FILE_PATTERN.test(entry.name)
    ) {
      continue;
    }
    files.push(path);
  }
  return files;
};

/** `"content-type": "text/event-stream"` in any spelling of the header name. */
const SSE_CONTENT_TYPE_PATTERN = /content-type"?\s*:\s*"text\/event-stream/iu;
const SSE_MEDIA_TYPE_PATTERN = /text\/event-stream/u;
const RESPONSE_CONSTRUCTION_PATTERN = /new Response\(/u;
const SSE_LIBRARY_RESPONSE_PATTERN = /toServerSentEventsResponse\(/u;
const HEARTBEAT_IMPORT_PATTERN = /from "@\/api\/lib\/sse-heartbeat"/u;

/** A module that can put event-stream bytes on the wire, however it builds them. */
const buildsEventStreamResponse = (source: string): boolean =>
  SSE_LIBRARY_RESPONSE_PATTERN.test(source) ||
  (SSE_MEDIA_TYPE_PATTERN.test(source) &&
    RESPONSE_CONSTRUCTION_PATTERN.test(source));

describe("every event stream is served through the heartbeat", () => {
  const sources = listSourceFiles(API_SOURCE).filter(
    (path) => path !== HEARTBEAT_MODULE,
  );

  test("the heartbeat module is the only place that names the media type in a response", () => {
    const offenders = sources.filter((path) =>
      SSE_CONTENT_TYPE_PATTERN.test(readFileSync(path, "utf-8")),
    );

    expect(offenders).toEqual([]);
  });

  test("a file that builds an event-stream response imports the heartbeat", () => {
    const builders = sources.filter((path) =>
      buildsEventStreamResponse(readFileSync(path, "utf-8")),
    );

    // The scan must find the known ones, or it is asserting over nothing.
    expect(builders.length).toBeGreaterThan(0);
    for (const path of builders) {
      expect(readFileSync(path, "utf-8")).toMatch(HEARTBEAT_IMPORT_PATTERN);
    }
  });
});
