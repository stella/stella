import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { createRedisDoorbell } from "@/api/lib/desktop-runner/doorbell";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type DoorbellClient = ReturnType<
  Parameters<typeof createRedisDoorbell>[0]["createClient"]
>;

/** Values in arrival order; `next` waits for one not yet taken. */
const inbox = <T>() => {
  const items: T[] = [];
  const waiting: ((value: T) => void)[] = [];
  return {
    push: (value: T) => {
      const waiter = waiting.shift();
      if (waiter === undefined) {
        items.push(value);
      } else {
        waiter(value);
      }
    },
    next: async (): Promise<T> => {
      if (items.length > 0) {
        const [value] = items.splice(0, 1);
        return value ?? panic("an inbox item went missing");
      }
      const arrived = Promise.withResolvers<T>();
      waiting.push(arrived.resolve);
      return await arrived.promise;
    },
  };
};

type Attempt = { outcome: "refused" | "subscribed" };
type Retry = { ms: number; run: () => void; cancelled: () => boolean };

/** A subscriber whose connection stays up while its first SUBSCRIBEs fail. */
const flakySubscriber = (failures: number) => {
  const calls = { subscribe: 0, unsubscribe: 0 };
  const listeners = new Map<string, (message: string) => void>();
  const reconnects = new Set<() => void>();
  const attempts = inbox<Attempt>();
  const retries = inbox<Retry>();
  const client = {
    publish: async () => await Promise.resolve(0),
    subscribe: async (channel: string, listener: (message: string) => void) => {
      calls.subscribe += 1;
      if (calls.subscribe <= failures) {
        attempts.push({ outcome: "refused" });
        throw new Error("SUBSCRIBE refused");
      }
      listeners.set(channel, listener);
      attempts.push({ outcome: "subscribed" });
      return await Promise.resolve(1);
    },
    unsubscribe: async (channel: string) => {
      calls.unsubscribe += 1;
      listeners.delete(channel);
      await Promise.resolve();
    },
    onReconnect: (handler: () => void) => {
      reconnects.add(handler);
      return () => {
        reconnects.delete(handler);
      };
    },
    close: () => undefined,
  };
  const doorbell = createRedisDoorbell({
    createClient: () => asTestRaw<DoorbellClient>(client),
    scheduleRetry: (run, ms) => {
      const state = { cancelled: false };
      retries.push({ ms, run, cancelled: () => state.cancelled });
      return () => {
        state.cancelled = true;
      };
    },
  });
  const reconnect = () => {
    for (const handler of reconnects) {
      handler();
    }
  };
  return { doorbell, calls, listeners, attempts, retries, reconnect };
};

describe("redis doorbell subscription", () => {
  test("a SUBSCRIBE that fails while the connection stays up is retried with backoff until it holds", async () => {
    const subscriber = flakySubscriber(2);
    const rings: string[] = [];
    const stop = await subscriber.doorbell.listen("api-one", (sessionId) => {
      rings.push(sessionId);
    });
    expect(await subscriber.attempts.next()).toEqual({ outcome: "refused" });
    const firstRetry = await subscriber.retries.next();
    firstRetry.run();
    expect(await subscriber.attempts.next()).toEqual({ outcome: "refused" });
    const secondRetry = await subscriber.retries.next();
    expect([firstRetry.ms, secondRetry.ms]).toEqual([1000, 2000]);
    secondRetry.run();
    expect(await subscriber.attempts.next()).toEqual({
      outcome: "subscribed",
    });
    subscriber.listeners.get("desktop-runner:api-one")?.("session-1");
    expect(rings).toEqual(["session-1"]);
    // A genuine reconnect renews the one subscription it replaces.
    subscriber.reconnect();
    expect(await subscriber.attempts.next()).toEqual({
      outcome: "subscribed",
    });
    expect(subscriber.calls).toEqual({ subscribe: 4, unsubscribe: 3 });
    expect(subscriber.listeners.size).toBe(1);
    await stop();
  });

  test("stopping during the retry wait cancels the retry", async () => {
    const subscriber = flakySubscriber(Number.POSITIVE_INFINITY);
    const stop = await subscriber.doorbell.listen("api-two", () => undefined);
    expect(await subscriber.attempts.next()).toEqual({ outcome: "refused" });
    const retry = await subscriber.retries.next();
    expect(retry.cancelled()).toBe(false);
    await stop();
    expect(retry.cancelled()).toBe(true);
  });
});
