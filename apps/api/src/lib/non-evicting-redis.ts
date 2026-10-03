import { panic, Result } from "better-result";

import { detached } from "@/api/lib/analytics/capture";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { RedisClientClosedError } from "@/api/lib/errors/tagged-errors";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";

const POLICY_COMMAND_TIMEOUT_MS = 250;
const POLICY_REFRESH_INTERVAL_MS = 60_000;

export const NON_EVICTING_STORE_MESSAGE =
  "Admission storage requires maxmemory-policy noeviction. Set maxmemory-policy noeviction in the Redis/Valkey server configuration.";

type RedisCommands = {
  send: (command: string, args: string[]) => Promise<unknown>;
  onReconnect?: (handler: () => void) => () => void;
};

type CheckedConnection = {
  client: RedisCommands;
  policy: StorePolicyObservation;
  checking: Promise<void> | undefined;
  generation: number;
};

export type StorePolicyObservation =
  | { status: "allowed" }
  | { status: "unknown" }
  | { status: "refused" };

type NonEvictingRedisOptions = {
  connection: { ready: () => Promise<RedisCommands>; close: () => void };
  observe: (observation: StorePolicyObservation) => void;
  scheduleRefresh?: (refresh: () => void) => () => void;
};

const schedulePolicyRefresh = (refresh: () => void) => {
  const timer = setInterval(refresh, POLICY_REFRESH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
};

/** A command facade: callers cannot obtain the unchecked admission client. */
export const nonEvictingRedis = ({
  connection,
  observe,
  scheduleRefresh = schedulePolicyRefresh,
}: NonEvictingRedisOptions) => {
  let current: CheckedConnection | undefined;
  let cancelRefresh: (() => void) | undefined;
  let cancelReconnect: (() => void) | undefined;

  const assertCurrent = (state: CheckedConnection) => {
    if (current !== state) {
      throw new RedisClientClosedError({
        message: "Admission client closed or replaced during policy inspection",
      });
    }
  };

  const check = (state: CheckedConnection) => {
    state.checking ??= (async () => {
      for (;;) {
        if (current !== state) {return;}
        const generation = state.generation;
        const reply = await Result.tryPromise(() =>
          withCommandTimeout({
            command: state.client.send("INFO", ["memory"]),
            commandTimeoutMs: POLICY_COMMAND_TIMEOUT_MS,
            label: "admission-store-policy",
          }),
        );
        if (current !== state) {
          return;
        }
        if (generation !== state.generation) {
          continue;
        }
        const reported =
          Result.isOk(reply) && typeof reply.value === "string"
            ? /^maxmemory_policy:([^\r\n]+)\r?$/mu
                .exec(reply.value)
                ?.at(1)
                ?.trim()
            : undefined;
        // Proxies and managed services may deny INFO or omit the field. That
        // cannot establish an unsafe policy; warn without blocking deployments.
        if (reported === undefined || reported.length === 0) {
          state.policy = { status: "unknown" };
        } else if (reported === "noeviction") {
          state.policy = { status: "allowed" };
        } else {
          state.policy = { status: "refused" };
        }
        observe(state.policy);
        return;
      }
    })().finally(() => {
      state.checking = undefined;
    });
    return state.checking;
  };

  const ready = async () => {
    const client = await connection.ready();
    if (current?.client !== client) {
      cancelReconnect?.();
      current = {
        client,
        policy: { status: "unknown" },
        checking: undefined,
        generation: 0,
      };
      const state = current;
      cancelReconnect = client.onReconnect?.(() => {
        // A reconnect supersedes the pending reply; the shared inspection
        // finishes with one check of the current connection before releasing callers.
        state.generation += 1;
        detached(check(state), "admission-store.inspect-policy");
      });
      // A replacement connection must not inherit the previous server's check.
      detached(check(current), "admission-store.inspect-policy");
      cancelRefresh ??= scheduleRefresh(() => {
        if (current !== undefined) {
          detached(check(current), "admission-store.inspect-policy");
        }
      });
    }
    const state = current;
    await state.checking;
    assertCurrent(state);
    return {
      send: async (command: string, args: string[]) => {
        await state.checking;
        assertCurrent(state);
        switch (state.policy.status) {
          case "refused":
            throw new ActionAdmissionError({
              message: NON_EVICTING_STORE_MESSAGE,
              reason: "unavailable",
            });
          case "allowed":
          case "unknown":
            return await client.send(command, args);
          default:
            state.policy satisfies never;
            return panic("Unhandled admission store policy");
        }
      },
    };
  };

  return {
    ready,
    close: () => {
      cancelRefresh?.();
      cancelReconnect?.();
      cancelRefresh = undefined;
      cancelReconnect = undefined;
      current = undefined;
      connection.close();
    },
  };
};
