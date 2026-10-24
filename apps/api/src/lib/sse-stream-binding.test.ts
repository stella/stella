import { describe, expect, test } from "bun:test";

import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { sseResponse, sweepBoundStreams } from "@/api/lib/sse";
import type { SseSessionLivenessReader, SseStreamBinding } from "@/api/lib/sse";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const OWNER = toSafeId<"user">("00000000-0000-7000-8000-0000000000a1");

/** A producer that writes what a test asks, and records how it ended. */
const openStream = (binding: SseStreamBinding) => {
  const ended: { reason: unknown; state: "cancelled" | "open" } = {
    reason: undefined,
    state: "open",
  };
  let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
  const source = new ReadableStream<Uint8Array>({
    start: (controller) => {
      producer = controller;
    },
    cancel: (reason: unknown) => {
      ended.state = "cancelled";
      ended.reason = reason;
    },
  });
  const reader =
    sseResponse(source, binding).body?.getReader() ??
    expect.unreachable("An event-stream response has a body");
  return {
    ended,
    reader,
    write: (text: string) => producer?.enqueue(encoder.encode(text)),
  };
};

const read = async (stream: ReturnType<typeof openStream>) => {
  const result = await stream.reader.read();
  return result.done ? "<done>" : decoder.decode(result.value);
};

const session = (sessionId: string, userId: SafeId<"user"> = OWNER) =>
  ({ kind: "session", sessionId, userId }) as const;

/** A liveness reader that holds `live` and records every read. */
const livenessOf = (live: readonly string[]) => {
  const reads: string[][] = [];
  const reader: SseSessionLivenessReader = async (sessions) => {
    reads.push(sessions.map(({ sessionId }) => sessionId).toSorted());
    return await Promise.resolve(
      new Set(
        sessions
          .map(({ sessionId }) => sessionId)
          .filter((id) => live.includes(id)),
      ),
    );
  };
  return { reader, reads };
};

describe("an event stream bound to the credential that opened it", () => {
  test("ends once its session is gone, as if its client had left, and leaves other sessions' streams open", async () => {
    const revoked = openStream(session("session-revoked"));
    const kept = openStream(session("session-kept"));
    revoked.write("data: before\n\n");
    expect(await read(revoked)).toBe("data: before\n\n");

    await sweepBoundStreams(livenessOf(["session-kept"]).reader);

    expect(await read(revoked)).toBe("<done>");
    expect(revoked.ended.state).toBe("cancelled");
    kept.write("data: still here\n\n");
    expect(await read(kept)).toBe("data: still here\n\n");
    expect(kept.ended.state).toBe("open");
    await kept.reader.cancel("test over");
  });

  test("reads every open stream's session once per sweep, however many streams share it", async () => {
    const streams = [
      openStream(session("session-a")),
      openStream(session("session-a")),
      openStream(session("session-b")),
    ];
    const liveness = livenessOf(["session-a", "session-b"]);

    await sweepBoundStreams(liveness.reader);

    expect(liveness.reads).toHaveLength(1);
    expect(liveness.reads[0]).toEqual(["session-a", "session-b"]);
    await Promise.all(streams.map(async (s) => await s.reader.cancel("over")));
  });

  test("forgets a stream once it has ended, so no later sweep asks about it", async () => {
    const left = openStream(session("session-left"));
    await left.reader.cancel("client left");
    const finished = openStream(session("session-finished"));
    await finished.reader.cancel("finished");
    const liveness = livenessOf([]);

    await sweepBoundStreams(liveness.reader);

    expect(liveness.reads).toEqual([]);
  });

  test("ends nothing when the session read fails, and ends the stream on the next sweep that reads it gone", async () => {
    const stream = openStream(session("session-unread"));

    await sweepBoundStreams(
      async () => await Promise.reject(new Error("database unavailable")),
    );
    expect(stream.ended.state).toBe("open");

    await sweepBoundStreams(livenessOf([]).reader);
    expect(await read(stream)).toBe("<done>");
  });

  test("ends a stream whose other credential no longer holds, and keeps one whose check could not run", async () => {
    let holds = true;
    const checked = openStream({
      kind: "credential",
      revalidate: async () => await Promise.resolve(holds),
    });
    const unchecked = openStream({
      kind: "credential",
      revalidate: async () =>
        await Promise.reject(new Error("verification unavailable")),
    });

    await sweepBoundStreams(livenessOf([]).reader);
    expect(checked.ended.state).toBe("open");

    holds = false;
    await sweepBoundStreams(livenessOf([]).reader);
    expect(await read(checked)).toBe("<done>");
    expect(checked.ended.state).toBe("cancelled");
    expect(unchecked.ended.state).toBe("open");
    await unchecked.reader.cancel("test over");
  });

  test("a session that belongs to another user does not keep a stream open", async () => {
    const stream = openStream(
      session(
        "session-shared-id",
        toSafeId<"user">("00000000-0000-7000-8000-0000000000b2"),
      ),
    );
    const owners: string[] = [];
    await sweepBoundStreams(async (sessions) => {
      owners.push(...sessions.map(({ userId }) => userId));
      return await Promise.resolve(new Set<string>());
    });

    expect(owners).toEqual(["00000000-0000-7000-8000-0000000000b2"]);
    expect(await read(stream)).toBe("<done>");
  });
});
