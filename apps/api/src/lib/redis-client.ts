import { Result } from "better-result";
import { type BunRedisRawClient, createBunRedisClient } from "bullmq";
import { type RedisOptions, RedisClient, sleep } from "bun";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { RedisClientClosedError } from "@/api/lib/errors/tagged-errors";
import { connectionErrorFields } from "@/api/lib/errors/utils";
import { logger } from "@/api/lib/observability/logger";
import { redisConnectionOptions } from "@/api/lib/redis-options";

// Re-exported so existing consumers keep one import site for "is this Valkey
// failure expected?" while the predicates themselves stay importable without
// this module's connection machinery.
export {
  isRecoverableRedisPollError,
  isTransientRedisConnectionError,
} from "@/api/lib/redis-error-classification";

class ConfiguredRedisClient extends RedisClient implements BunRedisRawClient {
  readonly #connectHandlers = new Set<() => void>();

  override onclose: (error?: Error) => void = () => undefined;
  // Declared as a non-null field so the class satisfies `BunRedisRawClient`
  // (Bun types the inherited `onconnect` as nullable). The field's own-property
  // is removed in the constructor before the real callback is registered — see
  // there for why the runtime path cannot be a plain field assignment.
  override onconnect: () => void = () => undefined;
  readonly url: string;

  constructor(
    url = envDocumentProcessingWorker.REDIS_URL,
    overrides?: RedisOptions,
  ) {
    super(url, { ...redisConnectionOptions(url), ...overrides });
    this.url = url;
    // Register one owned dispatcher on Bun's native `onconnect` setter so a
    // pub/sub subscriber can observe reconnects. Two facts (both verified
    // against a mock RESP3 server) shape this: (1) `onconnect` must be reached
    // through `[[Set]]` so Bun registers the callback — the class field above
    // defines an own data property that shadows the prototype setter, and a
    // callback stored that way never fires; deleting the own property first
    // makes the setter reachable. (2) Bun's RedisClient is not an EventTarget,
    // so a direct `this.onconnect = …` is the only real option, but the
    // prefer-add-event-listener lint rule bans that syntax — `Reflect.set`
    // performs the same `[[Set]]` without the banned member-assignment form.
    // The dispatcher fans every (re)connection out to the handlers registered
    // via `onReconnect`.
    Reflect.deleteProperty(this, "onconnect");
    Reflect.set(this, "onconnect", () => {
      for (const handler of this.#connectHandlers) {
        handler();
      }
    });
  }

  /**
   * Register `handler` to run on every (re)connection of this client,
   * including reconnects after a transient drop. Bun's RedisClient auto-
   * reconnects but does NOT re-issue SUBSCRIBE, so a pub/sub subscriber must
   * observe reconnects to re-establish its subscription (see sse.ts). Register
   * after the initial subscribe so the handler sees only genuine reconnects.
   * Returns a disposer that removes the handler.
   */
  onReconnect(handler: () => void): () => void {
    this.#connectHandlers.add(handler);
    return () => {
      this.#connectHandlers.delete(handler);
    };
  }
}

export const createRedisClient = (
  overrides?: RedisOptions,
): ConfiguredRedisClient =>
  new ConfiguredRedisClient(envDocumentProcessingWorker.REDIS_URL, overrides);

// On a Railway cold start the API container can win the race against its
// own Redis/Valkey service, so the very first connection attempt hits
// ECONNREFUSED/ENOTFOUND before Redis is accepting connections. BullMQ's
// RedisConnection calls `client.connect()` once (see `waitUntilReady` for
// the initial "wait" status) and rejects loudly through `worker.on("error")`
// on the first failure, with no retry of its own for that initial attempt.
// Retry a handful of times with a short capped backoff so that expected,
// self-recovering cold-start blips log at warn instead of paging as an
// error; once retries are exhausted the error is rethrown so BullMQ's own
// (unchanged) error handling still surfaces a persistent outage loudly.
const COLD_START_CONNECT_RETRY_DELAYS_MS = [200, 500, 1000, 2000];

export const connectWithColdStartRetries = async (
  connectOnce: () => Promise<void>,
): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    // catch returns the raw cause unchanged so a final, retries-exhausted
    // rethrow preserves the original error identity (code, syscall, class)
    // for whichever consumer's `worker.on("error")` handler logs it loudly.
    // oxlint-disable-next-line no-await-in-loop -- each retry must observe whether the connection came up before deciding to wait and try again
    const result = await Result.tryPromise({
      try: connectOnce,
      catch: (cause: unknown) => cause,
    });
    if (result.isOk()) {
      return;
    }
    const delayMs = COLD_START_CONNECT_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) {
      throw result.error;
    }
    logger.warn(
      "redis.cold_start_reconnect",
      connectionErrorFields(result.error),
    );
    // oxlint-disable-next-line no-await-in-loop -- retries are intentionally sequential backoff, not parallel work
    await sleep(delayMs);
  }
};

/** The two capabilities a lazily connected client has to expose. */
type ManagedRedisClient = {
  close: () => void;
  connect: () => Promise<void>;
};

type LazyRedisClient<Client> = {
  close: () => void;
  ready: () => Promise<Client>;
};

/**
 * A client that owns its own readiness. It is reachable only through
 * `ready()`, which builds it on first use and connects it through the
 * retry ladder above before handing it out, so no caller can issue a
 * command on a client that is still connecting. That matters for clients
 * built with the offline queue disabled, where such a command rejects
 * immediately instead of waiting for the socket.
 *
 * The connect runs once per client while it succeeds, and a rejected
 * attempt is discarded so the next caller retries rather than inheriting a
 * cached rejection. `close` drops the client and that memo together: a
 * caller after a shutdown builds and connects a fresh one instead of
 * receiving a resolved promise for a closed client, and a `ready()` still
 * in flight across a `close` fails rather than handing out the client it
 * was connecting.
 */
export const createLazyRedisClient = <Client extends ManagedRedisClient>(
  createClient: () => Client,
): LazyRedisClient<Client> => {
  let client: Client | null = null;
  let connected: Promise<void> | null = null;
  return {
    close: () => {
      client?.close();
      client = null;
      connected = null;
    },
    ready: async () => {
      const target = (client ??= createClient());
      if (connected === null) {
        const attempt: Promise<void> = connectWithColdStartRetries(async () => {
          await target.connect();
        }).catch((error: unknown) => {
          // Only this attempt may clear its own memo. A close and a later
          // caller can install another client's attempt while this ladder
          // is still climbing, and clearing that one would leave the new
          // client connecting twice over.
          if (connected === attempt) {
            connected = null;
          }
          throw error;
        });
        connected = attempt;
      }
      await connected;
      if (client !== target) {
        throw new RedisClientClosedError({
          message: "Redis client closed while connecting",
        });
      }
      return target;
    },
  };
};

const withColdStartConnectRetries = (
  connection: ReturnType<typeof createBunRedisClient>,
): ReturnType<typeof createBunRedisClient> => {
  const connectOnce = connection.connect.bind(connection);
  connection.connect = async () => {
    await connectWithColdStartRetries(connectOnce);
  };
  return connection;
};

/**
 * Build a BullMQ connection wrapped around a freshly-constructed Bun
 * RedisClient. BullMQ's adapter assigns onconnect/onclose on the raw
 * client, so a wrapped connection must own its raw client — never share
 * one with code that uses the client directly.
 *
 * Queue keys deliberately keep BullMQ's default `bull:` prefix, which carries
 * no hashtag and is therefore not cluster-legal. Every other key goes through
 * `redis-keys.ts` and already is (see `/conventions-scale`); the prefix is the
 * one documented exception, because a queue's keys ARE its jobs. Changing the
 * prefix mid-flight does not migrate them: the workers would start reading an
 * empty namespace and every queued, delayed, and retrying job under the old
 * prefix would be stranded with nothing to replay it. Deploying the change now
 * would therefore lose work silently, which no key-naming improvement is worth.
 *
 * The prefix flips at the cluster migration itself, as part of that cutover:
 * stop producers, let every queue drain to empty (`getJobCounts` at zero for
 * waiting/active/delayed/paused across all queues), then deploy the connection
 * change with `prefix: "{stella}"` set here. Until that cutover, do not
 * introduce a prefix, and do not add unhashtagged keys anywhere else.
 */
export const createBullMqConnection = (
  overrides?: RedisOptions,
): ReturnType<typeof createBunRedisClient> => {
  const raw = createRedisClient(overrides);
  const connection = createBunRedisClient(raw, {
    // Railway's Redis proxy can trigger Bun's eager adapter read path before
    // BullMQ has completed its own readiness flow. Let BullMQ connect lazily.
    lazyConnect: true,
  });
  return withColdStartConnectRetries(connection);
};
