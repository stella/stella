import { Result, TaggedError } from "better-result";
import { describe, expect, test } from "bun:test";

import {
  type BatchCommand,
  type BatchItem,
  type BatchResult,
  runBatch,
} from "./runner.js";

const sourceFor = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      command: "contacts create",
      input: { name: `Contact ${index}` },
    }),
  ).join("\n");

const inputSchema = {
  type: "object",
  properties: { name: { type: "string", minLength: 1 } },
  required: ["name"],
};

const resolveCommand = (execute: BatchCommand["execute"]) => () => ({
  access: "write" as const,
  inputSchema,
  execute,
});
const realClock = { now: () => 0, sleep: async () => undefined };

class FakeTransportFailure extends TaggedError("FakeTransportFailure")<{
  message: string;
}> {}

describe("batch runner", () => {
  test("lists uncertain writes without retrying, including on resume", async () => {
    let calls = 0;
    const command: BatchCommand = {
      access: "write",
      inputSchema,
      execute: async () => {
        calls += 1;
        return {
          status: "unknown",
          reason: "The response was lost after dispatch",
        };
      },
    };
    const first = await runBatch({
      source: sourceFor(1),
      resolve: () => command,
      ...realClock,
    });
    expect(calls).toBe(1);
    expect(first.unwrap().at(0)).toMatchObject({
      status: "unknown",
      reason: "The response was lost after dispatch",
    });
    const resumed = await runBatch({
      source: sourceFor(1),
      resume: first
        .unwrap()
        .map((result) => JSON.stringify(result))
        .join("\n"),
      resolve: () => command,
      ...realClock,
    });
    expect(calls).toBe(1);
    expect(resumed.unwrap()).toEqual(first.unwrap());
  });

  test("a lost response marks writes unknown and reads failed without retry", async () => {
    for (const access of ["read", "write"] as const) {
      let calls = 0;
      const command: BatchCommand = {
        access,
        inputSchema,
        execute: async () => {
          calls += 1;
          throw new FakeTransportFailure({
            message: "Connection closed after dispatch",
          });
        },
      };
      const outcome = await runBatch({
        source: sourceFor(1),
        resolve: () => command,
        ...realClock,
      });
      expect(calls).toBe(1);
      expect(outcome.unwrap().at(0)?.status).toBe(
        access === "write" ? "unknown" : "error",
      );
    }
  });

  test("emits in input order and never exceeds the selected concurrency", async () => {
    for (const concurrency of [1, 2, 6, 16]) {
      let active = 0;
      let maximum = 0;
      const emitted: BatchResult[] = [];
      const completed: number[] = [];
      const pending = new Map<number, () => void>();
      let ready = Promise.withResolvers<undefined>();
      const running = runBatch({
        source: sourceFor(33),
        concurrency,
        ...realClock,
        emit: (result) => {
          emitted.push(result);
        },
        resolve: resolveCommand(async ({ line }) => {
          active += 1;
          maximum = Math.max(maximum, active);
          const completion = Promise.withResolvers<undefined>();
          pending.set(line, () => completion.resolve(undefined));
          ready.resolve(undefined);
          await completion.promise;
          active -= 1;
          completed.push(line);
          return { status: "ok", result: line };
        }),
      });
      let released = 0;
      while (released < 33) {
        await ready.promise;
        ready = Promise.withResolvers<undefined>();
        for (const [line, release] of [...pending.entries()].toReversed()) {
          pending.delete(line);
          release();
          released += 1;
        }
      }
      const outcome = await running;
      expect(Result.isOk(outcome)).toBe(true);
      expect(maximum).toBe(concurrency);
      expect(active).toBe(0);
      const expected = Array.from({ length: 33 }, (_, index) => index + 1);
      expect(emitted.map(({ line }) => line)).toEqual(expected);
      expect(outcome.unwrap()).toEqual(emitted);
      if (concurrency > 1) {
        expect(completed).not.toEqual(expected);
      }
    }
  });

  test("backs off for Retry-After seconds and retries with the same identity", async () => {
    let time = 0;
    const waits: number[] = [];
    const calls: { time: number; item: BatchItem }[] = [];
    const outcome = await runBatch({
      source: sourceFor(2),
      concurrency: 1,
      now: () => time,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        time += milliseconds;
      },
      resolve: resolveCommand(async (item) => {
        calls.push({ time, item });
        return calls.length === 1
          ? { status: "rate_limited", retryAfter: "2" }
          : { status: "ok", result: item.line };
      }),
    });
    expect(outcome.unwrap().map(({ status }) => status)).toEqual(["ok", "ok"]);
    expect(waits).toEqual([2000]);
    expect(calls.map(({ time: start }) => start)).toEqual([0, 2000, 2000]);
    expect(calls.at(0)?.item.idempotencyKey).toBe(
      calls.at(1)?.item.idempotencyKey,
    );
  });

  test("honors Retry-After HTTP dates and stops after a finite retry budget", async () => {
    let time = Date.parse("2026-10-30T12:00:00Z");
    const waits: number[] = [];
    let calls = 0;
    const outcome = await runBatch({
      source: sourceFor(1),
      now: () => time,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        time += milliseconds;
      },
      resolve: resolveCommand(async () => {
        calls += 1;
        return {
          status: "rate_limited",
          retryAfter: new Date(time + 3000).toUTCString(),
        };
      }),
    });
    expect(calls).toBe(6);
    expect(waits).toEqual([3000, 3000, 3000, 3000, 3000]);
    expect(outcome.unwrap().at(0)?.status).toBe("error");
  });

  test("resume skips completed items and preserves keys for failed items", async () => {
    const firstCalls: BatchItem[] = [];
    const first = await runBatch({
      source: sourceFor(3),
      ...realClock,
      resolve: resolveCommand(async (item) => {
        firstCalls.push(item);
        return item.line === 2
          ? { status: "error", error: { code: "unavailable" } }
          : { status: "ok", result: item.line };
      }),
    });
    const secondCalls: BatchItem[] = [];
    const second = await runBatch({
      source: sourceFor(3),
      ...realClock,
      resume: first
        .unwrap()
        .map((result) => JSON.stringify(result))
        .join("\n"),
      resolve: resolveCommand(async (item) => {
        secondCalls.push(item);
        return { status: "ok", result: item.line };
      }),
    });
    expect(secondCalls.map(({ line }) => line)).toEqual([2]);
    expect(secondCalls.at(0)?.idempotencyKey).toBe(
      firstCalls.find(({ line }) => line === 2)?.idempotencyKey,
    );
    expect(second.unwrap().map(({ status }) => status)).toEqual([
      "skipped",
      "ok",
      "skipped",
    ]);
  });

  test("stable identity ignores object key order and caller identity survives a moved line", async () => {
    const keys: string[] = [];
    const resolve = resolveCommand(async (item) => {
      keys.push(item.idempotencyKey);
      return { status: "ok", result: item.id };
    });
    await runBatch({
      source:
        '{"command":"contacts create","input":{"name":"A","meta":{"a":1,"b":2}}}',
      resolve,
      ...realClock,
    });
    await runBatch({
      source:
        '{"input":{"meta":{"b":2,"a":1},"name":"A"},"command":"contacts create"}',
      resolve,
      ...realClock,
    });
    await runBatch({
      source:
        '{"id":"caller","command":"contacts create","input":{"name":"A"}}',
      resolve,
      ...realClock,
    });
    await runBatch({
      source:
        'broken\n{"id":"caller","command":"contacts create","input":{"name":"A"}}',
      resolve,
      ...realClock,
    });
    expect(keys.at(0)).toBe(keys.at(1));
    expect(keys.at(2)).toBe(keys.at(3));
  });

  test("dry run validates each schema including expanded references without executing", async () => {
    let calls = 0;
    const outcome = await runBatch({
      source: [
        '{"command":"contacts create","input":{"name":"A"}}',
        '{"command":"contacts create","input":{"name":12}}',
        '{"command":"contacts create","input":{}}',
      ].join("\n"),
      dryRun: true,
      ...realClock,
      resolve: () => ({
        access: "write",
        inputSchema: {
          type: "object",
          properties: { name: { $ref: "#/$defs/name" } },
          required: ["name"],
          $defs: { name: { type: "string" } },
        },
        execute: async () => {
          calls += 1;
          return { status: "ok", result: null };
        },
      }),
    });
    expect(calls).toBe(0);
    expect(outcome.unwrap().map(({ status }) => status)).toEqual([
      "skipped",
      "error",
      "error",
    ]);
    const replay = await runBatch({
      source: sourceFor(1),
      ...realClock,
      resume: JSON.stringify(outcome.unwrap().at(0)),
      resolve: resolveCommand(async () => {
        calls += 1;
        return { status: "ok", result: null };
      }),
    });
    expect(replay.unwrap().at(0)?.status).toBe("ok");
    expect(calls).toBe(1);
  });

  test("reports malformed lines and continues with later valid operations", async () => {
    const emitted: BatchResult[] = [];
    const outcome = await runBatch({
      source: `${sourceFor(1)}\nnot json\n[]\n\n${sourceFor(1)}\n`,
      ...realClock,
      resolve: resolveCommand(async ({ line }) => ({
        status: "ok",
        result: line,
      })),
      emit: (result) => {
        emitted.push(result);
      },
    });
    expect(outcome.unwrap().map(({ status }) => status)).toEqual([
      "ok",
      "error",
      "error",
      "error",
      "ok",
    ]);
    expect(emitted.map(({ line }) => line)).toEqual([1, 2, 3, 4, 5]);
  });

  test("rejects malformed resume receipts and invalid concurrency before calling transport", async () => {
    let calls = 0;
    const resolve = resolveCommand(async () => {
      calls += 1;
      return { status: "ok", result: null };
    });
    for (const concurrency of [0, 17, 1.5, Number.NaN]) {
      const outcome = await runBatch({
        source: sourceFor(1),
        concurrency,
        resolve,
        ...realClock,
      });
      expect(Result.isError(outcome)).toBe(true);
    }
    const malformed = await runBatch({
      source: sourceFor(1),
      resume: "not json",
      resolve,
      ...realClock,
    });
    expect(Result.isError(malformed)).toBe(true);
    expect(calls).toBe(0);
  });

  test("chunks only consecutive compatible commands within the endpoint maximum", async () => {
    const chunks: number[][] = [];
    const singles: number[] = [];
    const command: BatchCommand = {
      access: "write",
      inputSchema,
      execute: async ({ line }) => {
        singles.push(line);
        return { status: "ok", result: line };
      },
      bulk: {
        maxItems: 3,
        canGroup: (previous, next) =>
          previous.input["name"] !== "Contact 3" &&
          next.input["name"] !== "Contact 3",
        execute: async (items) => {
          chunks.push(items.map(({ line }) => line));
          return items.map(({ line }) => ({ status: "ok", result: line }));
        },
      },
    };
    const outcome = await runBatch({
      source: sourceFor(8),
      resolve: () => command,
      ...realClock,
    });
    expect(chunks).toEqual([
      [1, 2, 3],
      [5, 6, 7],
    ]);
    expect(singles).toEqual([4, 8]);
    expect(outcome.unwrap().map(({ line }) => line)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  test("resume preserves original bulk chunks after only part of their receipts were written", async () => {
    const requests: string[][] = [];
    const emitted: BatchResult[] = [];
    const command: BatchCommand = {
      access: "write",
      inputSchema,
      execute: async ({ idempotencyKey }) => {
        requests.push([idempotencyKey]);
        return { status: "ok", result: idempotencyKey };
      },
      bulk: {
        maxItems: 3,
        execute: async (items) => {
          requests.push(items.map(({ idempotencyKey }) => idempotencyKey));
          return items.map(({ idempotencyKey }) => ({
            status: "ok",
            result: idempotencyKey,
          }));
        },
      },
    };
    const first = await runBatch({
      source: sourceFor(8),
      resolve: () => command,
      ...realClock,
    });
    const originalRequests = requests.splice(0);
    // A crash can leave only the first result from an already committed chunk.
    const resume = first
      .unwrap()
      .slice(0, 4)
      .map((result) => JSON.stringify(result))
      .join("\n");
    const second = await runBatch({
      source: sourceFor(8),
      resume,
      resolve: () => command,
      emit: (result) => {
        emitted.push(result);
      },
      ...realClock,
    });
    expect(requests).toEqual(originalRequests.slice(1));
    expect(requests.at(0)).toHaveLength(3);
    expect(second.unwrap().map(({ status }) => status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(emitted).toEqual(second.unwrap());
  });

  test("whole bulk rate limits retain completed members on a resumed retry", async () => {
    const requests: string[][] = [];
    const command: BatchCommand = {
      access: "write",
      inputSchema,
      execute: async () => ({
        status: "error",
        error: "Expected original bulk transport",
      }),
      bulk: {
        maxItems: 3,
        execute: async (items) => {
          requests.push(items.map(({ idempotencyKey }) => idempotencyKey));
          return items.map(({ line }) =>
            requests.length === 2
              ? { status: "rate_limited", retryAfter: "0" }
              : { status: "ok", result: line },
          );
        },
      },
    };
    const first = await runBatch({
      source: sourceFor(3),
      resolve: () => command,
      ...realClock,
    });
    const second = await runBatch({
      source: sourceFor(3),
      resolve: () => command,
      resume: JSON.stringify(first.unwrap().at(0)),
      ...realClock,
    });
    expect(requests).toHaveLength(3);
    expect(requests.at(0)).toEqual(requests.at(1));
    expect(requests.at(1)).toEqual(requests.at(2));
    expect(second.unwrap().map(({ status }) => status)).toEqual([
      "skipped",
      "ok",
      "ok",
    ]);
  });

  test("retries only rate limited bulk items with their original keys", async () => {
    const bulkCalls: (readonly BatchItem[])[] = [];
    const singles: BatchItem[] = [];
    const command: BatchCommand = {
      access: "write",
      inputSchema,
      execute: async (item) => {
        singles.push(item);
        return { status: "ok", result: item.line };
      },
      bulk: {
        maxItems: 3,
        execute: async (items) => {
          bulkCalls.push(items);
          return items.map(({ line }) =>
            line === 2
              ? { status: "rate_limited", retryAfter: "0" }
              : { status: "ok", result: line },
          );
        },
      },
    };
    const outcome = await runBatch({
      source: sourceFor(3),
      resolve: () => command,
      ...realClock,
    });
    expect(bulkCalls).toHaveLength(1);
    expect(singles.map(({ line }) => line)).toEqual([2]);
    expect(singles.at(0)?.idempotencyKey).toBe(
      bulkCalls.at(0)?.at(1)?.idempotencyKey,
    );
    expect(outcome.unwrap().map(({ status }) => status)).toEqual([
      "ok",
      "ok",
      "ok",
    ]);
  });
});
