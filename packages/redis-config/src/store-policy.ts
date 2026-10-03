import { Result, TaggedError } from "better-result";

import { Temporal } from "@stll/time";

export type StoreClass = "durable-coordination" | "cache";
export type StorePolicyStatus = "allowed" | "unknown" | "refused";

export const STORE_POLICY_MESSAGE =
  "Coordination storage requires maxmemory-policy noeviction. Set maxmemory-policy noeviction in the Redis/Valkey server configuration.";

export class StoreUnavailableError extends TaggedError(
  "StoreUnavailableError",
)<{
  message: string;
  reason: "unavailable";
}> {}

const POLICY_REFRESH_MS = 60_000;
const POLICY_TIMEOUT_MS = 250;

type StorePolicyOptions = {
  storeClass: StoreClass;
  inspect: () => Promise<unknown>;
  observe: (status: StorePolicyStatus) => void;
  now?: () => number;
};

/** One inspection per connection and refresh interval, shared by concurrent commands. */
export const createStorePolicy = ({
  storeClass,
  inspect,
  observe,
  now = () => Temporal.Now.instant().epochMilliseconds,
}: StorePolicyOptions) => {
  let status: StorePolicyStatus = "unknown";
  let inspectedAt = Number.NEGATIVE_INFINITY;
  let checking: Promise<void> | undefined;
  let generation = 0;

  const refresh = async () => {
    const inspectedGeneration = generation;
    const attempt = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const result = await Result.tryPromise(async () => {
        const expired = new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), POLICY_TIMEOUT_MS);
        });
        return await Promise.race([inspect(), expired]);
      });
      clearTimeout(timeout);
      if (generation !== inspectedGeneration) {
        return;
      }
      const reported =
        result.isOk() && typeof result.value === "string"
          ? /^maxmemory_policy:([^\r\n]+)\r?$/mu
              .exec(result.value)
              ?.at(1)
              ?.trim()
          : undefined;
      if (reported === undefined || reported === "") {
        status = "unknown";
      } else if (reported === "noeviction") {
        status = "allowed";
      } else {
        status = "refused";
      }
      inspectedAt = now();
      observe(status);
    })();
    const pending = attempt.finally(() => {
      if (checking === pending) {
        checking = undefined;
      }
    });
    checking = pending;
    await pending;
  };

  return {
    invalidate: () => {
      generation += 1;
      inspectedAt = Number.NEGATIVE_INFINITY;
      checking = undefined;
    },
    assertAllowed: async () => {
      if (storeClass === "cache") {
        return;
      }
      while (now() - inspectedAt >= POLICY_REFRESH_MS) {
        await (checking ?? refresh());
      }
      if (status === "refused") {
        await Promise.reject(
          new StoreUnavailableError({
            message: STORE_POLICY_MESSAGE,
            reason: "unavailable",
          }),
        );
      }
    },
  };
};
