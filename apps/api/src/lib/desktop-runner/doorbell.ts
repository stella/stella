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
  detached(
    (async () => {
      const done = await Result.tryPromise(operation);
      if (done.isErr()) {
        onFailure(done.error);
      }
    })(),
    "desktop-runner.doorbell",
  );
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
};

/**
 * Rings across tasks over Redis pub/sub, one channel per task. A ring for a
 * task of this process skips Redis. Bun reconnects a subscriber without
 * re-issuing SUBSCRIBE, so the subscription is renewed on every reconnect; a
 * ring published while it is down is lost, which the sweep covers.
 */
export const createRedisDoorbell = ({
  createClient,
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
      const subscribe = async () =>
        await subscriber.subscribe(channel, (sessionId) => onRing(sessionId));
      const resubscribe = () => {
        bestEffort(async () => {
          await subscriber.unsubscribe(channel);
          await subscribe();
        }, observeSubscribeFailure);
      };
      const stopReconnects: { stop: () => void } = { stop: () => undefined };
      // Not awaited: a subscriber waits for Redis, and boot must not. Until it
      // is subscribed, rings for this task wait for the sweep. Reconnects are
      // observed only after the first subscription, so it is not issued twice.
      bestEffort(async () => {
        try {
          await subscribe();
        } finally {
          stopReconnects.stop = subscriber.onReconnect(resubscribe);
        }
      }, observeSubscribeFailure);
      return async () => {
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
