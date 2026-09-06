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

/**
 * Every client built here is long-lived, and Bun caps its reconnect ladder at
 * `maxRetries` (default 20, ≈31s of the 50ms→2s capped backoff). A client that
 * exhausts the ladder closes for good and cannot be revived in place, so its
 * holder would keep issuing commands into a socket that will never come back.
 * Reconnect without a cap instead and let the holder own the give-up decision:
 * a broker restart longer than the ladder is an outage to ride out, not a
 * reason to stop trying. Bun's backoff is unchanged, so this adds no load.
 *
 * The value is Bun's u32 ceiling; the option is read as a u32 and
 * `Number.MAX_SAFE_INTEGER` is rejected with `ERR_OUT_OF_RANGE`.
 */
const RECONNECT_ATTEMPT_LIMIT = 4_294_967_295;

/**
 * The connection options a caller may tune. `maxRetries` is not among them:
 * a bounded ladder is what closes a long-lived client for good, so it is set
 * once here rather than left open to a per-call-site override.
 */
export type RedisClientOverrides = Omit<RedisOptions, "maxRetries">;

/**
 * The options every client here is constructed with. A named value rather
 * than an inline object literal because Bun's RedisClient does not expose
 * what it was built with, so this is the only place the reconnect policy can
 * be read back and asserted.
 */
export const redisClientOptions = (
  url: string,
  overrides?: RedisClientOverrides,
): RedisOptions => ({
  // `enableOfflineQueue` is deliberately absent, so Bun's default (queue until
  // the connection is up) applies. A fresh client connects on its first
  // command, so disabling the queue here rejects that command outright — a
  // "create then send" caller such as the readiness probe would fail for the
  // length of the handshake it never got to wait for. A caller that wants
  // fail-fast semantics during an outage says so explicitly and bounds its own
  // commands, which is also what keeps the unbounded reconnect ladder above
  // from turning a queue into an outage-long backlog.
  ...redisConnectionOptions(url),
  ...overrides,
  maxRetries: RECONNECT_ATTEMPT_LIMIT,
});

// `duplicate` is left out of the claim: BullMQ types it `Promise<this>`, and
// Bun's inherited `duplicate()` resolves to a plain `RedisClient`, which no
// subclass-typed promise can satisfy. BullMQ only uses the result as a raw
// client (`_duplicateRaw`), and Bun's clone keeps the options this class was
// constructed with, so the reconnect policy above survives a duplicate. Every
// other member of the contract is still checked here.
class ConfiguredRedisClient
  extends RedisClient
  implements Omit<BunRedisRawClient, "duplicate">
{
  readonly #closeHandlers = new Set<() => void>();
  readonly #connectHandlers = new Set<() => void>();

  // Declared as non-null fields so the class satisfies `BunRedisRawClient`
  // (Bun types both inherited callbacks as nullable). Their own-properties are
  // removed in the constructor before the real callbacks are registered — see
  // there for why the runtime path cannot be a plain field assignment.
  override onclose: (error?: Error) => void = () => undefined;
  override onconnect: () => void = () => undefined;
  readonly url: string;

  constructor(
    url = envDocumentProcessingWorker.REDIS_URL,
    overrides?: RedisClientOverrides,
  ) {
    super(url, redisClientOptions(url, overrides));
    this.url = url;
    // Register one owned dispatcher on each of Bun's native `onconnect` /
    // `onclose` setters, so a pub/sub subscriber can observe reconnects and a
    // holder can observe a client going away for good. Two facts (both
    // verified against a mock RESP3 server) shape this: (1) the callback must
    // be reached through `[[Set]]` so Bun registers it — the class fields
    // above define own data properties that shadow the prototype setters, and
    // a callback stored that way never fires; deleting the own property first
    // makes the setter reachable. (2) Bun's RedisClient is not an EventTarget,
    // so a direct `this.onconnect = …` is the only real option, but the
    // prefer-add-event-listener lint rule bans that syntax — `Reflect.set`
    // performs the same `[[Set]]` without the banned member-assignment form.
    //
    // The shadow matters beyond this class: BullMQ's Bun adapter assigns
    // `raw.onclose` to drive its own reconnect scheduling, and an own data
    // property left in place would swallow that assignment silently.
    Reflect.deleteProperty(this, "onconnect");
    Reflect.set(this, "onconnect", () => {
      for (const handler of this.#connectHandlers) {
        handler();
      }
    });
    Reflect.deleteProperty(this, "onclose");
    Reflect.set(this, "onclose", () => {
      for (const handler of this.#closeHandlers) {
        handler();
      }
    });
  }

  /**
   * Register `handler` to run when this client's connection closes, whether
   * from an explicit `close()` or from Bun giving up on the socket. A closed
   * Bun client cannot be reopened, so a holder that wants to keep working past
   * one has to build a replacement (see `createLazyRedisClient`). Returns a
   * disposer that removes the handler.
   */
  onClose(handler: () => void): () => void {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
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
  overrides?: RedisClientOverrides,
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
// error; the last attempt is left unguarded so a persistent outage still
// reaches BullMQ's own (unchanged) error handling loudly.
const COLD_START_CONNECT_RETRY_DELAYS_MS = [200, 500, 1000, 2000];

export const connectWithColdStartRetries = async (
  connectOnce: () => Promise<void>,
): Promise<void> => {
  for (const delayMs of COLD_START_CONNECT_RETRY_DELAYS_MS) {
    // catch returns the raw cause unchanged so the warning below reports the
    // original error identity (code, syscall, class).
    const result = await Result.tryPromise({
      try: connectOnce,
      catch: (cause: unknown) => cause,
    });
    if (result.isOk()) {
      return;
    }
    logger.warn(
      "redis.cold_start_reconnect",
      connectionErrorFields(result.error),
    );
    await sleep(delayMs);
  }
  // One attempt per delay, then a final unguarded one: its rejection is the
  // caller's, with the original error identity intact for whichever
  // consumer's `worker.on("error")` handler logs the outage.
  await connectOnce();
};

/** The capabilities a lazily connected client has to expose. */
type ManagedRedisClient = {
  close: () => void;
  connect: () => Promise<void>;
  onClose: (handler: () => void) => () => void;
};

type LazyRedisClient<Client> = {
  close: () => void;
  ready: () => Promise<Client>;
};

/** One client, and the readiness of the connect attempt that built it. */
type ClientAttempt<Client> = {
  /**
   * Settle `ready` as a failure without waiting for the connect to return,
   * so a close during the ladder rejects the callers waiting on it.
   */
  abandon: (error: RedisClientClosedError) => void;
  client: Client;
  ready: Promise<Client>;
};

/**
 * A client that owns its own readiness. It is reachable only through
 * `ready()`, which builds it on first use and connects it through the
 * retry ladder above before handing it out, so no caller can issue a
 * command on a client that is still connecting. That matters for clients
 * built with the offline queue disabled, where such a command rejects
 * immediately instead of waiting for the socket.
 *
 * The connect runs once per client while it succeeds, and a failed attempt is
 * discarded so the next caller builds and connects a fresh client rather than
 * inheriting a cached rejection. The attempt is also discarded when the
 * connection closes, whether from `close()` or from Bun ending the socket: a
 * closed Bun client cannot be reopened, so keeping it would make every later
 * `ready()` hand out a dead socket. That is what lets the holder outlive a
 * broker restart longer than the client's own reconnect ladder.
 *
 * A `close()` while a connect is still climbing rejects the callers waiting on
 * it, rather than handing them the client it was connecting.
 */
export const createLazyRedisClient = <Client extends ManagedRedisClient>(
  createClient: () => Client,
): LazyRedisClient<Client> => {
  let current: ClientAttempt<Client> | null = null;

  const startAttempt = (): ClientAttempt<Client> => {
    const client = createClient();
    const abandoned = Promise.withResolvers<never>();
    const connected = connectWithColdStartRetries(async () => {
      await client.connect();
    }).then(() => client);
    const attempt: ClientAttempt<Client> = {
      abandon: abandoned.reject,
      client,
      // Whichever settles first wins, so a close is what rejects a waiting
      // caller, at the close itself rather than through a check after the
      // connect has run its course.
      ready: Promise.race([connected, abandoned.promise]),
    };
    // A closed Bun client cannot be reopened, so the attempt goes with it and
    // the next caller builds a replacement. Guarded on identity: a close
    // arriving after this attempt was already replaced must not drop its
    // successor, which would leave the new client connecting twice over.
    client.onClose(() => {
      if (current === attempt) {
        current = null;
      }
    });
    return attempt;
  };

  return {
    close: () => {
      const closing = current;
      current = null;
      if (closing === null) {
        return;
      }
      closing.abandon(
        new RedisClientClosedError({
          message: "Redis client closed while connecting",
        }),
      );
      closing.client.close();
    },
    ready: async () => {
      current ??= startAttempt();
      const attempt = current;
      const outcome = await Result.tryPromise({
        try: async () => await attempt.ready,
        catch: (cause: unknown) => cause,
      });
      if (Result.isOk(outcome)) {
        return outcome.value;
      }
      // A failure is not memoized: the next caller builds and connects a
      // fresh client instead of inheriting this one's rejection. Re-awaiting
      // the settled attempt hands this caller the original failure unchanged.
      if (current === attempt) {
        current = null;
      }
      return await attempt.ready;
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
  overrides?: RedisClientOverrides,
): ReturnType<typeof createBunRedisClient> => {
  // BullMQ's adapter owns command buffering across a reconnect (it schedules
  // its own and replays what it holds), so the connection states the offline
  // queue it needs rather than inheriting whatever the factory leaves unset. A
  // queue that wants its enqueues to fail fast still says so through
  // `overrides`.
  const raw = createRedisClient({ enableOfflineQueue: true, ...overrides });
  const connection = createBunRedisClient(raw, {
    // Railway's Redis proxy can trigger Bun's eager adapter read path before
    // BullMQ has completed its own readiness flow. Let BullMQ connect lazily.
    lazyConnect: true,
  });
  return withColdStartConnectRetries(connection);
};
