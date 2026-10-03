import { panic } from "better-result";

import {
  NON_EVICTING_STORE_MESSAGE,
  nonEvictingRedis,
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
      storeClass: "durable-coordination",
      overrides: {
        connectionTimeout: ADMISSION_STORE_CONNECTION_TIMEOUT_MS,
        enableOfflineQueue: false,
      },
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
          return panic("Unhandled admission store policy observation");
      }
    },
  });
