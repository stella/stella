/**
 * Rate limiter cold start against a reachable Valkey.
 *
 * The limiter's client runs with the offline queue disabled, so a command
 * issued before the socket is up rejects at once. This suite pins that the
 * first increment starts and awaits the connection, then is answered by the
 * peer rather than the fallback. `redis-outage.test.ts` covers the unreachable
 * side.
 */

import { RedisClient } from "bun";
import { afterAll, describe, expect, test } from "bun:test";

import type { RateLimitOptions } from "@/api/lib/rate-limit/contracts";

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
  test("the first increment awaits the lazy connection and is counted by the peer", async () => {
    const redisErrors: string[] = [];

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
          connect: async () => await client.connect(),
          send: async (command, args) => await client.send(command, args),
        };
      },
      failurePolicy: "fail_open_local",
      onRedisError: (_error, operation) => {
        redisErrors.push(operation);
      },
    });
    context.init(RATE_LIMIT_OPTIONS);

    const first = await context.increment("cold-start", RATE_LIMIT_WINDOW_MS);

    expect(redisErrors).toEqual([]);
    expect(first.count).toBe(PEER_COUNT);
    context.kill();
  });
});
