import { panic, Result } from "better-result";
import RedisClient, { Command, type RedisOptions } from "ioredis";
import type {
  ReplyMappingFromOptions,
  ReplyMappingMode,
} from "ioredis/built/types";

import {
  createStorePolicy,
  STORE_POLICY_MESSAGE,
  type StoreClass,
  type StorePolicyStatus,
} from "@stll/redis-config/store-policy";

import { logCollabEvent } from "./log";
import { collabRedisConnectionOptions } from "./redis-options";

type CollabRedisClientOptions = Parameters<
  typeof collabRedisConnectionOptions
>[0] & {
  storeClass: StoreClass;
  onPolicyStatus?: (status: StorePolicyStatus) => void;
};

type ClassifiedRedisClientOptions = {
  connectionOptions: ReturnType<typeof collabRedisConnectionOptions>;
  storeClass: StoreClass;
  onPolicyStatus?: CollabRedisClientOptions["onPolicyStatus"];
};

const POLICY_REFRESH_INTERVAL_MS = 60_000;

class ClassifiedRedisClient<
  Mapping extends ReplyMappingMode = "legacy",
> extends RedisClient<Mapping> {
  readonly #policy;
  readonly #storeClass;
  readonly #onPolicyStatus;

  constructor({
    connectionOptions,
    storeClass,
    onPolicyStatus,
  }: ClassifiedRedisClientOptions) {
    super({ ...connectionOptions, lazyConnect: true });
    this.#storeClass = storeClass;
    this.#onPolicyStatus = onPolicyStatus;
    this.#policy = createStorePolicy({
      storeClass,
      inspect: async () =>
        await super.sendCommand(
          new Command("info", ["memory"], { replyEncoding: "utf-8" }),
        ),
      observe: (status) => {
        onPolicyStatus?.(status);
        if (status === "allowed") {
          return;
        }
        logCollabEvent({
          event: "redis_store_policy",
          level: status === "refused" ? "error" : "warn",
          status,
          storeClass,
          operatorAction: STORE_POLICY_MESSAGE,
        });
      },
    });
    // Invalidate at disconnect: invalidating on the initial ready event would
    // discard the inspection whose INFO command established that connection.
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    const inspectPolicy = () => {
      void Result.tryPromise({
        try: () => this.#policy.assertAllowed(),
        catch: (cause: unknown) => cause,
      }).then((checked) => {
        if (Result.isError(checked)) {
          this.emit("error", checked.error);
        }
        return;
      });
    };
    this.on("close", () => {
      this.#policy.invalidate();
      clearInterval(refreshTimer);
      refreshTimer = undefined;
    });
    this.on("ready", () => {
      inspectPolicy();
      if (storeClass === "durable-coordination") {
        refreshTimer ??= setInterval(inspectPolicy, POLICY_REFRESH_INTERVAL_MS);
        refreshTimer.unref();
      }
    });
  }

  override duplicate<
    Override extends Partial<RedisOptions> | undefined = undefined,
  >(override?: Override) {
    return new ClassifiedRedisClient<
      ReplyMappingFromOptions<Mapping, Override>
    >({
      connectionOptions: { ...this.options, ...override },
      storeClass: this.#storeClass,
      onPolicyStatus: this.#onPolicyStatus,
    });
  }

  override sendCommand(
    ...args: Parameters<RedisClient["sendCommand"]>
  ): unknown {
    const [command] = args;
    // Driver handshake commands must run before policy inspection can complete.
    // The same driver-owned flag covers future handshake changes.
    if (
      (this.status !== "ready" &&
        Command.checkFlag("HANDSHAKE_COMMANDS", command.name)) ||
      command.name === "quit"
    ) {
      return super.sendCommand(...args);
    }
    void Result.tryPromise({
      try: () => this.#policy.assertAllowed(),
      catch: (cause: unknown) => {
        if (cause instanceof Error) {
          return cause;
        }
        return panic("Store policy rejected with a non-error value");
      },
    }).then((checked) => {
      if (Result.isError(checked)) {
        command.reject(checked.error);
        return;
      }
      const sent = Result.try(() => super.sendCommand(...args));
      if (Result.isError(sent)) {
        command.reject(sent.error);
      }
      return;
    });
    return command.promise;
  }
}

export const createCollabRedisClient = ({
  storeClass,
  onPolicyStatus,
  ...options
}: CollabRedisClientOptions) =>
  new ClassifiedRedisClient({
    connectionOptions: collabRedisConnectionOptions(options),
    storeClass,
    onPolicyStatus,
  });
