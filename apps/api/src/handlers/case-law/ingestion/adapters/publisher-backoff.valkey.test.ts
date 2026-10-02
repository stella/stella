import { describe, expect, test } from "bun:test";

import { createRedisClient } from "@/api/lib/redis-client";

import {
  abortableSleep,
  createPublisherRequestSlot,
  type PublisherGateClient,
  type PublisherRequestGateDependencies,
} from "./publisher-request-gate";

const runValkeyTests = process.env["STELLA_RUN_VALKEY_TESTS"] === "true";
const COOLDOWN_MS = 1000;
const INTERVAL_MS = 100;

type GateOptions = {
  client: PublisherGateClient;
  intervalMs?: number;
  sleep?: PublisherRequestGateDependencies["sleep"];
};

type PublisherStore = {
  first: ReturnType<typeof createRedisClient>;
  second: ReturnType<typeof createRedisClient>;
  key: string;
  cooldownKey: string;
  gate: (options: GateOptions) => ReturnType<typeof createPublisherRequestSlot>;
};

const withStore = async (run: (store: PublisherStore) => Promise<void>) => {
  const first = createRedisClient();
  const second = createRedisClient();
  const key = `publisher-backoff-test:${Bun.randomUUIDv7()}`;
  const cooldownKey = `${key}:cooldown`;
  try {
    await Promise.all([first.connect(), second.connect()]);
    await run({
      first,
      second,
      key,
      cooldownKey,
      gate: ({ client, intervalMs = INTERVAL_MS, sleep = abortableSleep }) =>
        createPublisherRequestSlot(
          {
            intervalMs,
            key,
            publisher: "ECJ backoff test",
            cooldown: "shared",
          },
          { redis: () => client, sleep },
        ),
    });
  } finally {
    try {
      if (first.connected) {
        await first.send("DEL", [key, cooldownKey]);
      }
    } finally {
      first.close();
      second.close();
    }
  }
};

const redisNow = async (client: PublisherStore["first"]) => {
  const clock = await client.send("TIME", []);
  if (!Array.isArray(clock)) {
    throw new TypeError("Redis TIME did not return an array");
  }
  const now =
    Number(clock.at(0)) * 1000 + Math.floor(Number(clock.at(1)) / 1000);
  expect(Number.isFinite(now)).toBe(true);
  return now;
};

const positiveTtl = async (client: PublisherStore["first"], key: string) => {
  const ttl = await client.send("PTTL", [key]);
  if (typeof ttl !== "number") {
    throw new TypeError("Redis PTTL did not return a number");
  }
  expect(ttl).toBeGreaterThan(0);
  return ttl;
};

if (!runValkeyTests || !process.env["REDIS_URL"]) {
  describe.skip("publisher backoff (valkey)", () => {
    test("requires STELLA_RUN_VALKEY_TESTS=true and REDIS_URL", () => {});
  });
} else {
  describe("publisher backoff (valkey)", () => {
    test("one client's Redis-time cooldown blocks another client until expiry", async () => {
      await withStore(async ({ first, second, key, cooldownKey, gate }) => {
        const before = await redisNow(first);
        await gate({ client: first }).defer(COOLDOWN_MS);
        const deadline = Number(await first.send("GET", [cooldownKey]));
        expect(deadline).toBeGreaterThanOrEqual(before + COOLDOWN_MS);
        expect(deadline).toBeLessThanOrEqual(
          (await redisNow(first)) + COOLDOWN_MS,
        );
        await positiveTtl(first, cooldownKey);

        const sleeping = Promise.withResolvers<number>();
        let admitted = false;
        const reservation = gate({
          client: second,
          sleep: async (durationMs, signal) => {
            sleeping.resolve(durationMs);
            await abortableSleep(durationMs, signal);
          },
        })().then(async () => {
          admitted = true;
          return await redisNow(second);
        });
        try {
          expect(await sleeping.promise).toBeGreaterThan(0);
          expect(admitted).toBe(false);
          await positiveTtl(first, key);
          expect(await reservation).toBeGreaterThanOrEqual(deadline);
          expect(await second.send("EXISTS", [cooldownKey])).toBe(0);
        } finally {
          await reservation;
        }
      });
    });

    test("a later longer backoff extends the shared deadline and a shorter one cannot shorten it", async () => {
      await withStore(async ({ first, second, cooldownKey, gate }) => {
        const firstGate = gate({ client: first });
        const secondGate = gate({ client: second });
        await firstGate.defer(COOLDOWN_MS);
        const original = Number(await first.send("GET", [cooldownKey]));
        const beforeExtension = await redisNow(second);
        await secondGate.defer(5000);
        const extended = Number(await second.send("GET", [cooldownKey]));
        expect(extended).toBeGreaterThan(original);
        expect(extended).toBeGreaterThanOrEqual(beforeExtension + 5000);
        expect(extended).toBeLessThanOrEqual((await redisNow(second)) + 5000);
        await firstGate.defer(INTERVAL_MS);
        expect(Number(await first.send("GET", [cooldownKey]))).toBe(extended);
        expect(await positiveTtl(second, cooldownKey)).toBeLessThanOrEqual(
          5000,
        );
      });
    });

    test("a sleeping reservation rechecks a cooldown announced by another client", async () => {
      await withStore(async ({ first, second, cooldownKey, gate }) => {
        const firstGate = gate({ client: first, intervalMs: 500 });
        await firstGate();
        const initialSleep = Promise.withResolvers<number>();
        const recheckedSleep = Promise.withResolvers<number>();
        const waits: number[] = [];
        let admitted = false;
        const reservation = gate({
          client: second,
          intervalMs: 500,
          sleep: async (durationMs, signal) => {
            waits.push(durationMs);
            if (waits.length === 1) {
              initialSleep.resolve(durationMs);
            } else if (waits.length === 2) {
              recheckedSleep.resolve(durationMs);
            }
            await abortableSleep(durationMs, signal);
          },
        })().then(async () => {
          admitted = true;
          return await redisNow(second);
        });
        try {
          expect(await initialSleep.promise).toBeGreaterThan(0);
          await firstGate.defer(COOLDOWN_MS);
          const deadline = Number(await first.send("GET", [cooldownKey]));
          // A missing recheck completes the reservation instead of entering
          // another sleep, so the race fails promptly on that mutation.
          await Promise.race([recheckedSleep.promise, reservation]);
          expect(admitted).toBe(false);
          expect(waits.at(1)).toBeGreaterThan(0);
          expect(await reservation).toBeGreaterThanOrEqual(deadline);
        } finally {
          await reservation;
        }
      });
    });

    test("cancelling a waiting reservation leaves only expiring keys and does not strand the next caller", async () => {
      await withStore(async ({ first, second, key, cooldownKey, gate }) => {
        await gate({ client: first }).defer(COOLDOWN_MS);
        const sleeping = Promise.withResolvers<undefined>();
        const controller = new AbortController();
        const reason = new DOMException(
          "Cancelled publisher request",
          "AbortError",
        );
        const secondGate = gate({
          client: second,
          sleep: async (durationMs, signal) => {
            sleeping.resolve(undefined);
            await abortableSleep(durationMs, signal);
          },
        });
        const reservation = secondGate(controller.signal);
        const failure = reservation.catch((error: unknown) => error);
        await sleeping.promise;
        const cooldownDeadline = await first.send("GET", [cooldownKey]);
        controller.abort(reason);
        expect(await failure).toBe(reason);
        // Cancellation cannot release another worker's shared cooldown.
        expect(await second.send("GET", [cooldownKey])).toBe(cooldownDeadline);
        const ttl = Math.max(
          await positiveTtl(first, key),
          await positiveTtl(first, cooldownKey),
        );
        await abortableSleep(ttl + 25);
        expect(await second.send("EXISTS", [key, cooldownKey])).toBe(0);
        await secondGate();
        await positiveTtl(second, key);
      });
    });

    test("an already cancelled request never creates reservation or cooldown keys", async () => {
      await withStore(async ({ first, key, cooldownKey, gate }) => {
        const controller = new AbortController();
        const reason = new DOMException("Already cancelled", "AbortError");
        controller.abort(reason);
        const firstGate = gate({ client: first });
        await expect(firstGate(controller.signal)).rejects.toBe(reason);
        await expect(
          firstGate.defer(COOLDOWN_MS, controller.signal),
        ).rejects.toBe(reason);
        expect(await first.send("EXISTS", [key, cooldownKey])).toBe(0);
      });
    });

    test("every key written by the real scripts carries a TTL", async () => {
      await withStore(async ({ first, key, cooldownKey, gate }) => {
        const checkedKeys = new Set<string>();
        const observed: PublisherGateClient = {
          send: async (command, args) => {
            const response = await first.send(command, args);
            const keyCount = Number(args.at(1));
            for (const scriptKey of args.slice(2, 2 + keyCount)) {
              const ttl = await first.send("PTTL", [scriptKey]);
              expect(ttl).not.toBe(-1);
              if (typeof ttl !== "number") {
                throw new TypeError("Redis PTTL did not return a number");
              }
              // A read-only cooldown check may name a key already expired.
              expect(ttl === -2 || ttl > 0).toBe(true);
              checkedKeys.add(scriptKey);
            }
            return response;
          },
        };
        const firstGate = gate({ client: observed });
        await firstGate.defer(0);
        expect(await first.send("EXISTS", [cooldownKey])).toBe(0);
        await firstGate.defer(INTERVAL_MS);
        await firstGate.defer(INTERVAL_MS * 2);
        await firstGate.defer(INTERVAL_MS);
        await firstGate();
        expect(checkedKeys).toEqual(new Set([key, cooldownKey]));
        await positiveTtl(first, key);
        expect(await first.send("EXISTS", [cooldownKey])).toBe(0);
      });
    });
  });
}
