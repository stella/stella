import { panic, Result } from "better-result";

import type { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import type { RedisClientClosedError } from "@/api/lib/errors/tagged-errors";
import {
  NON_EVICTING_STORE_MESSAGE,
  nonEvictingRedis,
  type NonEvictingRedisClient,
} from "@/api/lib/non-evicting-redis";
import { logger } from "@/api/lib/observability/logger";
import { emitAdmissionStorePolicyMetric } from "@/api/lib/observability/request-metrics";
import {
  createLazyRedisClient,
  createRedisClient,
} from "@/api/lib/redis-client";

const ADMISSION_STORE_CONNECTION_TIMEOUT_MS = 500;

type AdmissionRedisConnection = Parameters<
  typeof nonEvictingRedis
>[0]["connection"];

export const createAdmissionRedis = (
  connection: AdmissionRedisConnection = createLazyRedisClient(() =>
    createRedisClient({
      connectionTimeout: ADMISSION_STORE_CONNECTION_TIMEOUT_MS,
      enableOfflineQueue: false,
    }),
  ),
) =>
  nonEvictingRedis({
    connection,
    observe: ({ status }) => {
      emitAdmissionStorePolicyMetric(status === "refused");
      switch (status) {
        case "refused":
          logger.error("admission_store.eviction_policy_refused", {
            "operator.action": NON_EVICTING_STORE_MESSAGE,
          });
          return;
        case "unknown":
          logger.warn("admission_store.eviction_policy_unknown", {
            "operator.action":
              "INFO memory did not report maxmemory_policy; ensure maxmemory-policy noeviction is configured. Admission remains enabled because the policy cannot be inspected.",
          });
          return;
        case "allowed":
          return;
        default:
          status satisfies never;
          panic("Unhandled admission store policy observation");
      }
    },
  });

export type AdmissionRedisClient =
  | {
      send: (command: string, args: string[]) => Promise<unknown>;
      type?: never;
    }
  | NonEvictingRedisClient;
export type AdmissionRedisReady = () => Promise<
  AdmissionRedisClient | Result<NonEvictingRedisClient, RedisClientClosedError>
>;

export const resolveAdmissionRedisClient = async (
  ready: AdmissionRedisReady,
): Promise<Result<AdmissionRedisClient, RedisClientClosedError>> => {
  const connection = await ready();
  return "send" in connection ? Result.ok(connection) : connection;
};

export const sendAdmissionRedisCommand = async (
  client: AdmissionRedisClient,
  args: string[],
): Promise<Result<unknown, ActionAdmissionError | RedisClientClosedError>> =>
  client.type === "checked"
    ? await client.send("EVAL", args)
    : Result.ok(await client.send("EVAL", args));
