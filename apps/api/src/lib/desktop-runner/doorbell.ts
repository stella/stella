import { Result } from "better-result";

import { detached } from "@/api/lib/analytics/capture";
import type { RunHolder } from "@/api/lib/desktop-runner/store";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import type { createRedisClient } from "@/api/lib/redis-client";

/**
 * Nudges the API task holding a desktop's socket to read that socket's queue.
 * Postgres holds the queue and names the holder; a ring carries nothing else,
 * so a lost ring only delays delivery until the holder's next sweep or the
 * desktop's next connection.
 */
export type DesktopRunnerDoorbell = {
  readonly ring: (holder: RunHolder) => void;
  /** Deliver this task's rings to `onRing` until the returned stop runs. */
  readonly listen: (
    instanceId: string,
    onRing: (sessionId: string) => void,
  ) => Promise<() => Promise<void>>;
};

/**
 * Rings between tasks of one process: the whole doorbell of a single-task
 * deployment, and the local leg of the Redis doorbell.
 */
export const createLocalDoorbell = (): DesktopRunnerDoorbell => {
  const listeners = new Map<string, (sessionId: string) => void>();
  return {
    ring: ({ instanceId, sessionId }) => {
      const onRing = listeners.get(instanceId);
      if (onRing !== undefined) {
        queueMicrotask(() => onRing(sessionId));
      }
    },
    listen: async (instanceId, onRing) => {
      listeners.set(instanceId, onRing);
      return await Promise.resolve(async () => {
        listeners.delete(instanceId);
        await Promise.resolve();
      });
    },
  };
};

const DOORBELL_PUBLISH_SINK = failureSink({
  event: "desktop_runner.doorbell_publish_failed",
  expected: [],
});
const DOORBELL_SUBSCRIBE_SINK = failureSink({
  event: "desktop_runner.doorbell_subscribe_failed",
  expected: [],
});

const observePublishFailure = (error: unknown) => {
  observeFailure(error, { sink: DOORBELL_PUBLISH_SINK });
};
const observeSubscribeFailure = (error: unknown) => {
  observeFailure(error, { sink: DOORBELL_SUBSCRIBE_SINK });
};

/**
 * Run a doorbell operation without waiting for it. A failure is observed and
 * otherwise ignored: the sweep and the next reconnect read the queue anyway.
 */
const bestEffort = (
  operation: () => Promise<unknown>,
  onFailure: (error: unknown) => void,
) => {
  detached(async () => {
    const done = await Result.tryPromise(operation);
    if (done.isErr()) {
      onFailure(done.error);
    }
  }, "desktop-runner.doorbell");
};

const PUBLISH_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 2000;

const channelOf = (instanceId: string) => `desktop-runner:${instanceId}`;

type RedisDoorbellClient = Pick<
  ReturnType<typeof createRedisClient>,
  "publish" | "subscribe" | "unsubscribe" | "onReconnect" | "close"
>;

type RedisDoorbellOptions = {
  createClient: (
    options: Parameters<typeof createRedisClient>[0],
  ) => RedisDoorbellClient;
  /** Schedules a retry of a failed SUBSCRIBE; returns its cancel. */
  scheduleRetry?: (run: () => void, ms: number) => () => void;
};

/** First wait before a failed SUBSCRIBE is retried; it doubles up to the cap. */
const SUBSCRIBE_RETRY_MS = 1000;
const SUBSCRIBE_RETRY_CAP_MS = 30_000;

const scheduleOnClock = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => {
    clearTimeout(timer);
  };
};

/**
 * Rings across tasks over Redis pub/sub, one channel per task. A ring for a
 * task of this process skips Redis. Bun reconnects a subscriber without
 * re-issuing SUBSCRIBE, so the subscription is renewed on every reconnect, and
 * a SUBSCRIBE that fails on a live connection is retried on a timer; a ring
 * published while it is down is lost, which the sweep covers.
 */
export const createRedisDoorbell = ({
  createClient,
  scheduleRetry = scheduleOnClock,
}: RedisDoorbellOptions): DesktopRunnerDoorbell => {
  const local = createLocalDoorbell();
  const localInstances = new Set<string>();
  let publisher: RedisDoorbellClient | null = null;
  const publish = async ({ instanceId, sessionId }: RunHolder) => {
    publisher ??= createClient({
      storeClass: "cache",
      overrides: {
        connectionTimeout: CONNECT_TIMEOUT_MS,
        enableOfflineQueue: false,
      },
    });
    await withCommandTimeout({
      command: publisher.publish(channelOf(instanceId), sessionId),
      commandTimeoutMs: PUBLISH_TIMEOUT_MS,
      label: "desktop runner doorbell publish",
    });
  };
  return {
    ring: (holder) => {
      if (localInstances.has(holder.instanceId)) {
        local.ring(holder);
        return;
      }
      bestEffort(async () => await publish(holder), observePublishFailure);
    },
    listen: async (instanceId, onRing) => {
      const stopLocal = await local.listen(instanceId, onRing);
      localInstances.add(instanceId);
      const subscriber = createClient({ storeClass: "cache" });
      const channel = channelOf(instanceId);
      const subscription = {
        stopped: false,
        cancelRetry: (): void => undefined,
        /** Renewals run one at a time, so a channel is never subscribed twice. */
        queue: Promise.resolve(),
      };
      // Read fresh after every await: a stop can land while one is pending.
      const stopped = () => subscription.stopped;
      // SUBSCRIBE, after an UNSUBSCRIBE unless it is the first one. A failure
      // is observed and retried on a timer, so a connection that stays up
      // never stays unsubscribed; a reconnect renews at once instead.
      const renew = async (attempt: number, first: boolean) => {
        subscription.cancelRetry();
        const previous = subscription.queue;
        subscription.queue = (async () => {
          await previous;
          if (stopped()) {
            return;
          }
          const renewed = await Result.tryPromise(async () => {
            if (!first) {
              await subscriber.unsubscribe(channel);
            }
            await subscriber.subscribe(channel, (sessionId) =>
              onRing(sessionId),
            );
          });
          if (renewed.isOk() || stopped()) {
            return;
          }
          observeSubscribeFailure(renewed.error);
          subscription.cancelRetry = scheduleRetry(
            () => {
              detached(
                async () => await renew(attempt + 1, false),
                "desktop-runner.doorbell",
              );
            },
            Math.min(SUBSCRIBE_RETRY_MS * 2 ** attempt, SUBSCRIBE_RETRY_CAP_MS),
          );
        })();
        await subscription.queue;
      };
      const stopReconnects: { stop: () => void } = { stop: () => undefined };
      // Not awaited: a subscriber waits for Redis, and boot must not. Until it
      // is subscribed, rings for this task wait for the sweep. Reconnects are
      // observed only after the first attempt, so it is not issued twice.
      bestEffort(async () => {
        await renew(0, true);
        if (!stopped()) {
          stopReconnects.stop = subscriber.onReconnect(() => {
            detached(
              async () => await renew(0, false),
              "desktop-runner.doorbell",
            );
          });
        }
      }, observeSubscribeFailure);
      return async () => {
        subscription.stopped = true;
        subscription.cancelRetry();
        stopReconnects.stop();
        localInstances.delete(instanceId);
        await stopLocal();
        subscriber.close();
        publisher?.close();
        publisher = null;
      };
    },
  };
};

/** One reader's subscription to a run's bell. */
export type DesktopRunnerRunListener = {
  /**
   * Resolve once the run rang since the previous wait, `timeoutMs` passed or
   * `signal` aborted, whichever comes first. A ring between two waits is kept,
   * so a reader that reads and then waits never misses one.
   */
  readonly wait: (options: {
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<void>;
  readonly close: () => void;
};

/**
 * Wakes whoever reads a run's stored messages, on any task, once the gateway
 * stored more. A ring carries only the run id and the reader reads Postgres,
 * so a lost ring only delays a reader until its bounded wait times out.
 */
export type DesktopRunnerRunBell = {
  readonly ring: (runId: string) => void;
  readonly listen: (runId: string) => DesktopRunnerRunListener;
};

type RunWaiter = { rang: boolean; wake: (() => void) | null };

/** The readers of this process, by run. */
const createRunWaiters = () => {
  const waiters = new Map<string, Set<RunWaiter>>();
  const deliver = (runId: string) => {
    for (const waiter of waiters.get(runId) ?? []) {
      waiter.rang = true;
      waiter.wake?.();
    }
  };
  const listen = (runId: string): DesktopRunnerRunListener => {
    const waiter: RunWaiter = { rang: false, wake: null };
    const forRun = waiters.get(runId) ?? new Set<RunWaiter>();
    forRun.add(waiter);
    waiters.set(runId, forRun);
    return {
      wait: async ({ timeoutMs, signal }) => {
        if (waiter.rang || signal.aborted) {
          waiter.rang = false;
          return;
        }
        const woken = Promise.withResolvers<undefined>();
        const timer = setTimeout(() => woken.resolve(undefined), timeoutMs);
        const onAbort = () => woken.resolve(undefined);
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.wake = () => woken.resolve(undefined);
        await woken.promise;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        waiter.wake = null;
        waiter.rang = false;
      },
      close: () => {
        forRun.delete(waiter);
        if (forRun.size === 0 && waiters.get(runId) === forRun) {
          waiters.delete(runId);
        }
      },
    };
  };
  return { deliver, listen };
};

/** Rings within one process: a single-task deployment's whole bell. */
export const createLocalRunBell = (): DesktopRunnerRunBell => {
  const waiters = createRunWaiters();
  return {
    ring: (runId) => {
      queueMicrotask(() => waiters.deliver(runId));
    },
    listen: waiters.listen,
  };
};

const RUN_BELL_CHANNEL = "desktop-runner-run-events";

type RedisRunBellOptions = Pick<RedisDoorbellOptions, "createClient">;

/**
 * Rings every task over one Redis channel; each task wakes its own readers of
 * the run. Readers on the ringing task wake at once without Redis. The
 * subscription opens with the first reader and stays for the process; while
 * it is down readers fall back to their bounded wait.
 */
export const createRedisRunBell = ({
  createClient,
}: RedisRunBellOptions): DesktopRunnerRunBell => {
  const waiters = createRunWaiters();
  let publisher: RedisDoorbellClient | null = null;
  let subscribed: Promise<void> | null = null;
  const subscribe = () => {
    const attempt = (async () => {
      const subscriber = createClient({ storeClass: "cache" });
      const renew = async () => {
        await subscriber.subscribe(RUN_BELL_CHANNEL, (runId) => {
          waiters.deliver(runId);
        });
      };
      await renew();
      // Bun reconnects a subscriber without re-issuing SUBSCRIBE.
      subscriber.onReconnect(() => {
        bestEffort(renew, observeSubscribeFailure);
      });
    })();
    subscribed = attempt;
    bestEffort(
      async () => await attempt,
      (error) => {
        // A failed subscribe is retried by the next reader.
        subscribed = null;
        observeSubscribeFailure(error);
      },
    );
  };
  return {
    ring: (runId) => {
      queueMicrotask(() => waiters.deliver(runId));
      bestEffort(async () => {
        publisher ??= createClient({
          storeClass: "cache",
          overrides: {
            connectionTimeout: CONNECT_TIMEOUT_MS,
            enableOfflineQueue: false,
          },
        });
        await withCommandTimeout({
          command: publisher.publish(RUN_BELL_CHANNEL, runId),
          commandTimeoutMs: PUBLISH_TIMEOUT_MS,
          label: "desktop runner run bell publish",
        });
      }, observePublishFailure);
    },
    listen: (runId) => {
      if (subscribed === null) {
        subscribe();
      }
      return waiters.listen(runId);
    },
  };
};
