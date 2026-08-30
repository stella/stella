/**
 * Rate limiter cold start against a reachable Valkey.
 *
 * The limiter's client runs with the offline queue disabled, so a command
 * issued before the socket is up rejects at once and the request falls back
 * to the per-process counter. Connecting eagerly at construction is what keeps
 * the first requests after a process start on Redis; this suite pins that the
 * first increment after the connect settles is answered by the peer, not by
 * the fallback. `redis-outage.test.ts` covers the unreachable side.
 */

import { RedisClient } from "bun";
import { afterAll, describe, expect, test } from "bun:test";

import type { RateLimitOptions } from "@/api/lib/rate-limit/rate-limit";

// Any count the per-process fallback cannot produce on a first increment, so
// the assertion below can only pass when the reply came from the peer.
const PEER_COUNT = 7;
const PEER_TTL_MS = 60_000;

// Speaks just enough RESP to complete a handshake and answer the increment
// script with a fixed counter reply, so the client reaches a genuinely
// connected state and the limiter parses a real EVAL result.
const peer = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: {
    data(socket, data) {
      const isEval = data.toString().includes("EVAL");
      socket.write(
        isEval ? `*2\r\n:${PEER_COUNT}\r\n:${PEER_TTL_MS}\r\n` : "+OK\r\n",
      );
    },
  },
});

const { RedisRateLimitContext } =
  await import("@/api/lib/rate-limit/redis-context");

const RATE_LIMIT_WINDOW_MS = 60_000;
const CONNECT_DEADLINE_MS = 5000;
const RATE_LIMIT_OPTIONS = {
  duration: RATE_LIMIT_WINDOW_MS,
  generator: () => "cold-start-client",
  max: 10,
  skip: () => false,
} as const satisfies Omit<RateLimitOptions, "context">;

afterAll(() => {
  peer.stop(true);
});

describe("rate limiter cold start against a reachable Valkey", () => {
  test("the first increment after the eager connect settles is counted by the peer", async () => {
    const redisErrors: string[] = [];
    let settleConnect: () => void = () => undefined;
    const connected = new Promise<void>((resolve) => {
      settleConnect = resolve;
    });

    const context = new RedisRateLimitContext({
      createRedis: () => {
        // Inject the peer at the client boundary: shared-process test batches
        // may already have evaluated the validated env module for another
        // file, so mutating process.env here would depend on import order.
        const client = new RedisClient(`redis://127.0.0.1:${peer.port}`, {
          connectionTimeout: 500,
          enableOfflineQueue: false,
        });
        return {
          close: () => client.close(),
          // Observes the limiter's own connect call; the test never connects
          // on the client's behalf, so a limiter that stops connecting at
          // construction leaves this promise pending and fails the deadline.
          connect: async () => {
            await client.connect();
            settleConnect();
          },
          send: async (command, args) => await client.send(command, args),
        };
      },
      failurePolicy: "fail_open_local",
      onRedisError: (_error, operation) => {
        redisErrors.push(operation);
      },
    });
    context.init(RATE_LIMIT_OPTIONS);

    const deadline = new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("the limiter never connected to the local peer"));
      }, CONNECT_DEADLINE_MS);
      timer.unref();
    });
    await Promise.race([connected, deadline]);

    const first = await context.increment("cold-start", RATE_LIMIT_WINDOW_MS);

    expect(redisErrors).toEqual([]);
    expect(first.count).toBe(PEER_COUNT);
    context.kill();
  });
});
