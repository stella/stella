import type { UIMessage, UIMessageChunk } from "ai";

import { RivetChatTransport } from "./rivet-transport";
import type { ChatStreamConnection, SequencedChunk } from "./rivet-transport";

// ── Constants ──────────────────────────────────────────────

const THREAD_ID = "test-thread-1";
const OTHER_THREAD_ID = "other-thread-99";

// ── Helpers ────────────────────────────────────────────────

type ChunkCallback = (payload: SequencedChunk) => void;

const createMockConnection = () => {
  const listeners: ChunkCallback[] = [];

  const connection: ChatStreamConnection = {
    on: vi.fn((_eventName: "stream-chunk", callback: ChunkCallback) => {
      listeners.push(callback);
      return () => {
        const idx = listeners.indexOf(callback);
        if (idx !== -1) {
          listeners.splice(idx, 1);
        }
      };
    }),
    sendMessages: vi.fn(async () => ({
      status: "started" as const,
    })),
    stop: vi.fn(async () => {
      // no-op
    }),
    getStreamSnapshot: vi.fn(async () => ({
      done: false,
      snapshot: [] as SequencedChunk[],
    })),
  };

  const emit = (chunk: SequencedChunk) => {
    for (const listener of [...listeners]) {
      listener(chunk);
    }
  };

  return { connection, emit, listeners };
};

const collectStream = async <T>(stream: ReadableStream<T>): Promise<T[]> => {
  const reader = stream.getReader();
  const chunks: T[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
  }
  return chunks;
};

const makeChunk = (
  seq: number,
  chunk: UIMessageChunk,
  threadId = THREAD_ID,
): SequencedChunk => ({ threadId, seq, chunk });

const textDelta = (
  seq: number,
  delta: string,
  threadId?: string,
): SequencedChunk =>
  makeChunk(seq, { type: "text-delta", id: "part-1", delta }, threadId);

const finishChunk = (seq: number, threadId?: string): SequencedChunk =>
  makeChunk(seq, { type: "finish" }, threadId);

const makeMessage = (content: string): UIMessage => ({
  id: `msg-${content}`,
  role: "user",
  parts: [{ type: "text", text: content }],
});

const makeSendOptions = (messages: UIMessage[]) => ({
  trigger: "submit-message" as const,
  chatId: "chat-1",
  messageId: undefined,
  messages,
  abortSignal: undefined,
});

// ── Tests ──────────────────────────────────────────────────

describe(RivetChatTransport, () => {
  describe("sendMessages", () => {
    it("enqueues chunks into the ReadableStream", async () => {
      const { connection, emit, listeners } = createMockConnection();
      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.sendMessages(
        makeSendOptions([makeMessage("Hello")]),
      );

      emit(textDelta(0, "Hi"));
      emit(textDelta(1, " there"));
      emit(finishChunk(2));

      const chunks = await collectStream(stream);

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toStrictEqual({
        type: "text-delta",
        id: "part-1",
        delta: "Hi",
      });
      expect(chunks[1]).toStrictEqual({
        type: "text-delta",
        id: "part-1",
        delta: " there",
      });
      expect(chunks[2]).toStrictEqual({ type: "finish" });
      expect(listeners).toHaveLength(0);
    });

    it("filters out chunks for other threads", async () => {
      const { connection, emit, listeners } = createMockConnection();
      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.sendMessages(
        makeSendOptions([makeMessage("Hello")]),
      );

      emit(textDelta(0, "wrong", OTHER_THREAD_ID));
      emit(textDelta(0, "right", THREAD_ID));
      emit(finishChunk(1));

      const chunks = await collectStream(stream);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toStrictEqual({
        type: "text-delta",
        id: "part-1",
        delta: "right",
      });
      expect(listeners).toHaveLength(0);
    });

    it("resets lastSeq on each call", async () => {
      const { connection, emit } = createMockConnection();
      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      // First call: advance lastSeq to 5
      const s1 = await transport.sendMessages(
        makeSendOptions([makeMessage("First")]),
      );
      emit(textDelta(0, "a"));
      emit(finishChunk(5));
      await collectStream(s1);

      // Second call resets lastSeq to -1. Reconnect
      // immediately before any chunks arrive, so
      // lastSeq is still -1 and resumeFrom = 0.
      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: true,
        snapshot: [],
      });

      await transport.sendMessages(makeSendOptions([makeMessage("Second")]));

      await transport.reconnectToStream();

      expect(connection.getStreamSnapshot).toHaveBeenLastCalledWith({
        threadId: THREAD_ID,
        startFromSeq: 0,
      });
    });

    it("throws when no messages provided", async () => {
      const { connection } = createMockConnection();
      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      await expect(transport.sendMessages(makeSendOptions([]))).rejects.toThrow(
        "No messages to send",
      );
    });

    it("sends the last message to the connection", async () => {
      const { connection, emit } = createMockConnection();
      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const messages = [makeMessage("First"), makeMessage("Second")];

      const stream = await transport.sendMessages(makeSendOptions(messages));
      emit(finishChunk(0));
      await collectStream(stream);

      expect(connection.sendMessages).toHaveBeenCalledWith({
        chatId: "chat-1",
        threadId: THREAD_ID,
        message: messages[1],
      });
    });

    it("closes stream and calls stop on abort", async () => {
      const { connection, listeners } = createMockConnection();
      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const controller = new AbortController();

      const stream = await transport.sendMessages({
        ...makeSendOptions([makeMessage("Hello")]),
        abortSignal: controller.signal,
      });

      controller.abort();

      await vi.waitFor(() => {
        expect(connection.stop).toHaveBeenCalledWith({
          threadId: THREAD_ID,
        });
      });

      // Stream should be closed after abort
      const reader = stream.getReader();
      const { done } = await reader.read();
      expect(done).toBeTruthy();
      expect(listeners).toHaveLength(0);
    });

    it("cancels stream when status is busy", async () => {
      const { connection, listeners } = createMockConnection();
      vi.mocked(connection.sendMessages).mockResolvedValueOnce({
        status: "busy",
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.sendMessages(
        makeSendOptions([makeMessage("Hello")]),
      );

      const reader = stream.getReader();
      const { done } = await reader.read();
      expect(done).toBeTruthy();
      expect(listeners).toHaveLength(0);
    });

    it("unsubscribes on enqueue failure", async () => {
      const { connection, emit, listeners } = createMockConnection();

      // Use reconnect: its live pipe has no cancel
      // callback, so cancelling the reader leaves
      // the listener active while the controller
      // is closed.
      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: false,
        snapshot: [],
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {
        // suppress
      });

      const stream = await transport.reconnectToStream();
      if (stream === null) {
        expect.unreachable("stream should not be null");
      }

      // Cancel from the consumer side; the pipe
      // listener stays subscribed.
      const reader = stream.getReader();
      await reader.cancel();

      expect(listeners).toHaveLength(1);

      // Chunk arrives on the still-active listener,
      // but the controller is closed; the error path
      // should unsubscribe.
      emit(textDelta(0, "after cancel"));

      // eslint-disable-next-line jest/prefer-called-with -- verifying call happened, not specific args
      expect(consoleSpy).toHaveBeenCalled();
      expect(listeners).toHaveLength(0);

      vi.restoreAllMocks();
    });
  });

  describe("reconnectToStream", () => {
    it("returns null when stream is done", async () => {
      const { connection } = createMockConnection();
      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: true,
        snapshot: [],
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const result = await transport.reconnectToStream();

      expect(result).toBeNull();
    });

    it("requests snapshot from lastSeq + 1", async () => {
      const { connection, emit } = createMockConnection();
      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      // Advance lastSeq to 2
      const s1 = await transport.sendMessages(
        makeSendOptions([makeMessage("Hello")]),
      );
      emit(textDelta(0, "a"));
      emit(textDelta(1, "b"));
      emit(finishChunk(2));
      await collectStream(s1);

      // Reconnect should request from seq 3
      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: false,
        snapshot: [textDelta(3, "c")],
      });

      const stream = await transport.reconnectToStream();

      expect(connection.getStreamSnapshot).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        startFromSeq: 3,
      });

      // Clean up
      if (stream) {
        emit(finishChunk(4));
        await collectStream(stream);
      }
    });

    it("replays snapshot then pipes live events", async () => {
      const { connection, emit, listeners } = createMockConnection();

      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: false,
        snapshot: [textDelta(0, "snap-1"), textDelta(1, "snap-2")],
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.reconnectToStream();
      if (stream === null) {
        expect.unreachable("stream should not be null");
      }

      // After snapshot replay, live events should flow
      emit(textDelta(2, "live-1"));
      emit(finishChunk(3));

      const chunks = await collectStream(stream);
      const deltas = chunks
        .filter(
          (c): c is Extract<UIMessageChunk, { type: "text-delta" }> =>
            c.type === "text-delta",
        )
        .map((c) => c.delta);

      expect(deltas).toStrictEqual(["snap-1", "snap-2", "live-1"]);
      expect(chunks.at(-1)?.type).toBe("finish");
      expect(listeners).toHaveLength(0);
    });

    it("merges buffered events arriving during snapshot fetch", async () => {
      const { connection, emit, listeners } = createMockConnection();

      vi.mocked(connection.getStreamSnapshot).mockImplementationOnce(() => {
        // Simulate: realtime event arrives while the
        // snapshot RPC is in flight. seq=2 is beyond
        // the snapshot's last seq of 1.
        emit(textDelta(2, "buffered-realtime"));

        return Promise.resolve({
          done: false as const,
          snapshot: [textDelta(0, "snap-0"), textDelta(1, "snap-1")],
        });
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.reconnectToStream();
      if (stream === null) {
        expect.unreachable("stream should not be null");
      }

      emit(finishChunk(3));

      const chunks = await collectStream(stream);
      const deltas = chunks
        .filter(
          (c): c is Extract<UIMessageChunk, { type: "text-delta" }> =>
            c.type === "text-delta",
        )
        .map((c) => c.delta);

      expect(deltas).toStrictEqual(["snap-0", "snap-1", "buffered-realtime"]);
      expect(listeners).toHaveLength(0);
    });

    it("deduplicates overlapping snapshot and buffer events", async () => {
      const { connection, emit, listeners } = createMockConnection();

      vi.mocked(connection.getStreamSnapshot).mockImplementationOnce(() => {
        // Realtime event with seq=1 arrives during
        // snapshot fetch. Snapshot also has seq=1.
        // Only one copy should appear.
        emit(textDelta(1, "dup"));

        return Promise.resolve({
          done: false as const,
          snapshot: [textDelta(0, "snap-0"), textDelta(1, "dup")],
        });
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.reconnectToStream();
      if (stream === null) {
        expect.unreachable("stream should not be null");
      }

      emit(finishChunk(2));

      const chunks = await collectStream(stream);
      const deltas = chunks
        .filter(
          (c): c is Extract<UIMessageChunk, { type: "text-delta" }> =>
            c.type === "text-delta",
        )
        .map((c) => c.delta);

      // "dup" appears only once (from snapshot)
      expect(deltas).toStrictEqual(["snap-0", "dup"]);
      expect(listeners).toHaveLength(0);
    });

    it("closes stream if snapshot contains finish chunk", async () => {
      const { connection, listeners } = createMockConnection();

      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: false,
        snapshot: [textDelta(0, "data"), finishChunk(1)],
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.reconnectToStream();
      if (stream === null) {
        expect.unreachable("stream should not be null");
      }

      const chunks = await collectStream(stream);

      expect(chunks).toHaveLength(2);
      expect(chunks.at(-1)?.type).toBe("finish");
      expect(listeners).toHaveLength(0);
    });

    it("unsubscribes buffer listener when done", async () => {
      const { connection, listeners } = createMockConnection();

      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: true,
        snapshot: [],
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      await transport.reconnectToStream();

      expect(listeners).toHaveLength(0);
    });

    it("reconnects from a fresh transport", async () => {
      const { connection, emit, listeners } = createMockConnection();

      // Never called sendMessages; lastSeq is -1,
      // so resumeFrom should be 0.
      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: false,
        snapshot: [textDelta(0, "first")],
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.reconnectToStream();
      if (stream === null) {
        expect.unreachable("stream should not be null");
      }

      expect(connection.getStreamSnapshot).toHaveBeenCalledWith({
        threadId: THREAD_ID,
        startFromSeq: 0,
      });

      emit(finishChunk(1));
      await collectStream(stream);
      expect(listeners).toHaveLength(0);
    });

    it("finish chunk in realtime buffer closes stream", async () => {
      const { connection, emit, listeners } = createMockConnection();

      vi.mocked(connection.getStreamSnapshot).mockImplementationOnce(() => {
        // Finish arrives in the buffer while the
        // snapshot RPC is in flight.
        emit(finishChunk(2));

        return Promise.resolve({
          done: false as const,
          snapshot: [textDelta(0, "a"), textDelta(1, "b")],
        });
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.reconnectToStream();
      if (stream === null) {
        expect.unreachable("stream should not be null");
      }

      const chunks = await collectStream(stream);
      const types = chunks.map((c) => c.type);

      expect(types).toStrictEqual(["text-delta", "text-delta", "finish"]);
      expect(listeners).toHaveLength(0);
    });

    it("empty snapshot with buffered events", async () => {
      const { connection, emit, listeners } = createMockConnection();

      vi.mocked(connection.getStreamSnapshot).mockImplementationOnce(() => {
        // Events arrive while snapshot returns empty
        // (server just started emitting).
        emit(textDelta(0, "buf-0"));
        emit(textDelta(1, "buf-1"));

        return Promise.resolve({
          done: false as const,
          snapshot: [],
        });
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const stream = await transport.reconnectToStream();
      if (stream === null) {
        expect.unreachable("stream should not be null");
      }

      emit(finishChunk(2));

      const chunks = await collectStream(stream);
      const deltas = chunks
        .filter(
          (c): c is Extract<UIMessageChunk, { type: "text-delta" }> =>
            c.type === "text-delta",
        )
        .map((c) => c.delta);

      expect(deltas).toStrictEqual(["buf-0", "buf-1"]);
      expect(listeners).toHaveLength(0);
    });

    it("advances lastSeq through snapshot replay", async () => {
      const { connection, emit } = createMockConnection();

      // First reconnect: replay snapshot up to seq 2.
      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: false,
        snapshot: [textDelta(0, "a"), textDelta(1, "b"), textDelta(2, "c")],
      });

      const transport = new RivetChatTransport({
        connection,
        threadId: THREAD_ID,
      });

      const s1 = await transport.reconnectToStream();
      if (s1 === null) {
        expect.unreachable("stream should not be null");
      }
      emit(finishChunk(3));
      await collectStream(s1);

      // Second reconnect should resume from seq 4.
      vi.mocked(connection.getStreamSnapshot).mockResolvedValueOnce({
        done: true,
        snapshot: [],
      });

      await transport.reconnectToStream();

      expect(connection.getStreamSnapshot).toHaveBeenLastCalledWith({
        threadId: THREAD_ID,
        startFromSeq: 4,
      });
    });
  });
});
