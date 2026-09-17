import { fetchServerSentEvents } from "@tanstack/ai-client";
import { describe, expect, it } from "bun:test";

import { SSE_HEARTBEAT_FRAME } from "@stll/api-contract/sse-heartbeat";

import { parseSSEEvents, readSSEEvents } from "@/lib/sse-events";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const streamOf = (chunks: readonly string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encode(chunk));
      }
      controller.close();
    },
  });

describe("parseSSEEvents", () => {
  it("reads the event name and joins multi-line data", () => {
    expect(
      parseSSEEvents('event: position\ndata: {"a":1}\ndata: {"b":2}\n\n'),
    ).toEqual([{ event: "position", data: '{"a":1}\n{"b":2}' }]);
  });

  it("names an unlabelled frame the default event", () => {
    expect(parseSSEEvents("data: hello\n\n")).toEqual([
      { event: "message", data: "hello" },
    ]);
  });

  it("splits consecutive frames", () => {
    expect(
      parseSSEEvents("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n").map(
        (frame) => frame.event,
      ),
    ).toEqual(["a", "b"]);
  });

  it("dispatches nothing for the server's keep-alive frame", () => {
    expect(parseSSEEvents(SSE_HEARTBEAT_FRAME)).toEqual([]);
    expect(
      parseSSEEvents(`${SSE_HEARTBEAT_FRAME}event: a\ndata: 1\n\n`),
    ).toEqual([{ event: "a", data: "1" }]);
  });
});

describe("the TanStack chat client reading the same keep-alive frame", () => {
  it("yields no chunk for it", async () => {
    const terminalChunk = {
      type: "RUN_FINISHED",
      threadId: "thread-1",
      runId: "run-1",
      timestamp: 1,
    };
    const fetchClient: typeof fetch = Object.assign(
      async () =>
        new Response(
          streamOf([
            SSE_HEARTBEAT_FRAME,
            `data: ${JSON.stringify(terminalChunk)}\n\n`,
          ]),
          { headers: { "content-type": "text/event-stream" } },
        ),
      { preconnect: () => undefined },
    );
    const connection = fetchServerSentEvents("https://example.invalid/chat", {
      fetchClient,
    });

    const chunks = [];
    for await (const chunk of connection.connect(
      [],
      {},
      new AbortController().signal,
      { runId: "run-1", threadId: "thread-1" },
    )) {
      chunks.push(chunk);
    }

    // Two frames on the wire, one chunk out: the keep-alive dispatched nothing.
    expect(chunks).toHaveLength(1);
    expect(chunks.at(0)).toMatchObject({ runId: "run-1" });
  });
});

describe("readSSEEvents", () => {
  it("holds a frame split across chunks until it is whole", async () => {
    const seen: string[] = [];
    const outcome = await readSSEEvents(
      streamOf(["event: pos", "ition\ndata: 1\n\nevent: done\ndata: 2\n\n"]),
      (frame) => {
        seen.push(`${frame.event}:${frame.data}`);
        return true;
      },
    );
    expect(seen).toEqual(["position:1", "done:2"]);
    expect(outcome).toBe("drained");
  });

  it("stops reading as soon as the consumer hangs up", async () => {
    const seen: string[] = [];
    const outcome = await readSSEEvents(
      streamOf(["event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"]),
      (frame) => {
        seen.push(frame.event);
        return false;
      },
    );
    expect(seen).toEqual(["a"]);
    expect(outcome).toBe("stopped");
  });

  it("drops a trailing frame the stream never finished", async () => {
    const seen: string[] = [];
    await readSSEEvents(streamOf(["event: a\ndata: 1"]), (frame) => {
      seen.push(frame.event);
      return true;
    });
    expect(seen).toEqual([]);
  });
});
