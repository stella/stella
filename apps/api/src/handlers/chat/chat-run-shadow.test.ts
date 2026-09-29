import { EventType } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { shadowChatRun } from "@/api/handlers/chat/chat-run-shadow";
import type { emitChatRunLogMetric } from "@/api/lib/observability/request-metrics";

const chunks = (count: number): StreamChunk[] =>
  Array.from(
    { length: count },
    (_, index) =>
      ({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: `part-${index}`,
      }) satisfies StreamChunk,
  );

const from = async function* (values: StreamChunk[]) {
  yield* values;
};

const collect = async (source: AsyncIterable<StreamChunk>) => {
  const output: StreamChunk[] = [];
  for await (const chunk of source) {
    output.push(chunk);
  }
  return output;
};

describe("chat run shadow", () => {
  test("persists streamed chunks in order and reports successful metrics", async () => {
    const input = chunks(3);
    const persisted: StreamChunk[] = [];
    const metrics: Parameters<typeof emitChatRunLogMetric>[0][] = [];
    const shadow = shadowChatRun({
      enabled: true,
      createLog: () => ({
        append: async (batch) => {
          const firstOffset = persisted.length + 1;
          persisted.push(...batch);
          return batch.map((_, index) => String(firstOffset + index));
        },
      }),
      source: from(input),
      observe: () => {},
      measure: (metric) => metrics.push(metric),
    });

    expect(await collect(shadow.source)).toEqual(input);
    await shadow.flush();
    await Promise.resolve();

    expect(persisted).toEqual(input);
    expect(metrics.filter((metric) => metric.type === "turn")).toEqual([
      {
        type: "turn",
        rows: input.length,
        bytes: input.reduce(
          (total, chunk) =>
            total + new TextEncoder().encode(JSON.stringify(chunk)).byteLength,
          0,
        ),
      },
    ]);
    expect(metrics.some((metric) => metric.type === "append")).toBe(true);
  });

  test("observes append failure without changing delivered chunks", async () => {
    const input = chunks(2);
    const observed: unknown[] = [];
    const shadow = shadowChatRun({
      enabled: true,
      createLog: () => ({
        append: async () => {
          throw new Error("append unavailable");
        },
      }),
      source: from(input),
      observe: (error) => observed.push(error),
      measure: () => {},
    });

    expect(await collect(shadow.source)).toEqual(input);
    await shadow.flush();

    expect(observed).toHaveLength(1);
    expect(String(observed.at(0))).toContain("append unavailable");
  });

  test("does not construct a log when shadowing is disabled", async () => {
    const input = chunks(1);
    let created = false;
    const shadow = shadowChatRun({
      enabled: false,
      createLog: () => {
        created = true;
        throw new Error("disabled shadow created a log");
      },
      source: from(input),
    });

    expect(await collect(shadow.source)).toEqual(input);
    await shadow.flush();
    expect(created).toBe(false);
  });

  test("bounds flush when an append never settles", async () => {
    const observed: unknown[] = [];
    const shadow = shadowChatRun({
      enabled: true,
      createLog: () => ({ append: () => new Promise<string[]>(() => {}) }),
      source: from(chunks(1)),
      observe: (error) => observed.push(error),
      measure: () => {},
    });

    const delivered = await collect(shadow.source);
    const started = performance.now();
    await shadow.flush();

    expect(delivered).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(500);
    expect(observed).toHaveLength(1);
    expect(observed.at(0)).toMatchObject({
      message: "Chat shadow log drain timed out",
    });
  });

  test("stops accepting chunks when the pending backlog reaches its limit", async () => {
    const observed: unknown[] = [];
    let appendStarted = false;
    const shadow = shadowChatRun({
      enabled: true,
      createLog: () => ({
        append: () => {
          appendStarted = true;
          return new Promise<string[]>(() => {});
        },
      }),
      source: from(chunks(258)),
      observe: (error) => observed.push(error),
      measure: () => {},
    });

    const delivered = await collect(shadow.source);
    await shadow.flush();

    expect(appendStarted).toBe(true);
    expect(delivered).toHaveLength(258);
    expect(observed).toHaveLength(1);
    expect(observed.at(0)).toMatchObject({
      message: "Chat shadow log budget exceeded",
    });
  });

  test("observes an oversized chunk budget failure without changing delivery", async () => {
    const input = [
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "x".repeat(256 * 1024),
      } satisfies StreamChunk,
    ];
    const observed: unknown[] = [];
    let appendStarted = false;
    const shadow = shadowChatRun({
      enabled: true,
      createLog: () => ({
        append: async () => {
          appendStarted = true;
          return [];
        },
      }),
      source: from(input),
      observe: (error) => observed.push(error),
      measure: () => {},
    });

    expect(await collect(shadow.source)).toEqual(input);
    await shadow.flush();

    expect(appendStarted).toBe(false);
    expect(observed).toHaveLength(1);
    expect(observed.at(0)).toMatchObject({
      message: "Chat shadow log budget exceeded",
    });
  });

  test("observes an in-flight append rejection after the drain times out", async () => {
    const append = Promise.withResolvers<string[]>();
    const timeoutObserved = Promise.withResolvers<undefined>();
    const appendFailureObserved = Promise.withResolvers<unknown>();
    const shadow = shadowChatRun({
      enabled: true,
      createLog: () => ({ append: () => append.promise }),
      source: from(chunks(1)),
      observe: (error) => {
        const message = String(error);
        if (message.includes("Chat shadow log drain timed out")) {
          timeoutObserved.resolve(undefined);
        }
        if (message.includes("append rejected after timeout")) {
          appendFailureObserved.resolve(error);
        }
      },
      measure: () => {},
    });

    expect(await collect(shadow.source)).toEqual(chunks(1));
    const flushing = shadow.flush();
    await timeoutObserved.promise;
    await flushing;
    append.reject(new Error("append rejected after timeout"));

    expect(String(await appendFailureObserved.promise)).toContain(
      "append rejected after timeout",
    );
  });
});
