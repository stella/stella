import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { providerDiagnosticSchema } from "@stll/api-contract/provider-setup";
import type { ProviderDiagnostic } from "@stll/api-contract/provider-setup";

import type { SafeId } from "@/api/lib/branded-types";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import { createRedisClient } from "@/api/lib/redis-client";
import {
  coordinationKey,
  coordinationSetArguments,
  type CoordinationKey,
} from "@/api/lib/redis-keys";

const FAILURE_TTL_SECONDS = 600;
const COMMAND_TIMEOUT_MS = 500;
const failureSchema = v.strictObject({
  status: v.literal("error"),
  providerDiagnostic: v.optional(providerDiagnosticSchema),
});

export class AnalysisFailureStoreError extends TaggedError(
  "AnalysisFailureStoreError",
)<{
  message: string;
  cause?: unknown;
}> {}

type AnalysisFailureScope = {
  organizationId: SafeId<"organization">;
  decisionId: SafeId<"caseLawDecision">;
  fingerprint: string;
};
type RedisLike = {
  connect: () => Promise<void>;
  send: (command: string, args: string[]) => Promise<unknown>;
};
type AnalysisFailureStoreOptions = {
  createRedis?: () => RedisLike;
  commandTimeoutMs?: number;
};

/** One delivery to the initiating organization; its next explicit request can retry. */
export const createAnalysisFailureStore = ({
  createRedis = () =>
    createRedisClient({
      storeClass: "cache",
      overrides: {
        connectionTimeout: COMMAND_TIMEOUT_MS,
        enableOfflineQueue: false,
      },
    }),
  commandTimeoutMs = COMMAND_TIMEOUT_MS,
}: AnalysisFailureStoreOptions = {}) => {
  let redis: RedisLike | undefined;
  const command = async (
    options:
      | { name: "SET"; key: CoordinationKey; value: string }
      | { name: "GETDEL"; key: CoordinationKey },
  ) => {
    const result = await Result.tryPromise({
      try: async () =>
        await withCommandTimeout({
          command: (async () => {
            redis ??= createRedis();
            await redis.connect();
            switch (options.name) {
              case "SET":
                return await redis.send(
                  "SET",
                  coordinationSetArguments({
                    key: options.key,
                    value: options.value,
                    ttl: { unit: "seconds", value: FAILURE_TTL_SECONDS },
                  }),
                );
              case "GETDEL":
                return await redis.send("GETDEL", [options.key]);
              default:
                options satisfies never;
                return panic("Unhandled analysis failure command");
            }
          })(),
          commandTimeoutMs,
          label: "case-law-analysis-failure",
        }),
      catch: (cause) =>
        new AnalysisFailureStoreError({
          message: "Analysis failure delivery is unavailable",
          cause,
        }),
    });
    if (Result.isError(result)) {
      throw result.error;
    }
    return result.value;
  };
  const keyFor = ({
    organizationId,
    decisionId,
    fingerprint,
  }: AnalysisFailureScope) =>
    coordinationKey({
      scope: "case-law-analysis-failure",
      slot: `${organizationId}:${decisionId}`,
      suffix: fingerprint,
    });
  return {
    write: async (
      scope: AnalysisFailureScope,
      providerDiagnostic: ProviderDiagnostic | undefined,
    ) => {
      const failure = {
        status: "error",
        ...(providerDiagnostic === undefined ? {} : { providerDiagnostic }),
      } as const;
      await command({
        name: "SET",
        key: keyFor(scope),
        value: JSON.stringify(failure),
      });
    },
    take: async (scope: AnalysisFailureScope) => {
      const reply = await command({ name: "GETDEL", key: keyFor(scope) });
      if (reply === null) {
        return null;
      }
      if (typeof reply !== "string") {
        throw new AnalysisFailureStoreError({
          message: "Invalid analysis failure delivery",
        });
      }
      const decoded = Result.try((): unknown => JSON.parse(reply));
      if (decoded.isErr()) {
        throw new AnalysisFailureStoreError({
          message: "Invalid analysis failure delivery",
        });
      }
      const parsed = v.safeParse(failureSchema, decoded.value);
      if (!parsed.success) {
        throw new AnalysisFailureStoreError({
          message: "Invalid analysis failure delivery",
        });
      }
      return parsed.output;
    },
  };
};

let store: ReturnType<typeof createAnalysisFailureStore> | undefined;
export const analysisFailureStore = () => {
  store ??= createAnalysisFailureStore();
  return store;
};
