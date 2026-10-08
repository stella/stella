import { panic, Result, TaggedError } from "better-result";
import * as v from "valibot";

import { providerDiagnosticSchema } from "@stll/api-contract/provider-setup";

import type { SafeId } from "@/api/lib/branded-types";
import type { RedactedProviderDiagnostic } from "@/api/lib/provider-diagnostic";
import { withCommandTimeout } from "@/api/lib/rate-limit/redis-command-timeout";
import { createRedisClient } from "@/api/lib/redis-client";
import {
  coordinationKey,
  coordinationSetArguments,
  type CoordinationKey,
} from "@/api/lib/redis-keys";

const FAILURE_TTL_SECONDS = 600;
const COMMAND_TIMEOUT_MS = 500;
const CLEAR_OBSERVED_FAILURE = `
local failure = redis.call('GET', KEYS[1])
if failure and cjson.decode(failure).failureId == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const failureSchema = v.strictObject({
  failureId: v.pipe(v.string(), v.uuid()),
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

/** Terminal failure shared by the organization's readers until retry or expiry. */
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
      | { name: "GET"; key: CoordinationKey }
      | { name: "clear"; key: CoordinationKey; expected: string },
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
              case "GET":
                return await redis.send(options.name, [options.key]);
              case "clear":
                return await redis.send("EVAL", [
                  CLEAR_OBSERVED_FAILURE,
                  "1",
                  options.key,
                  options.expected,
                ]);
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
    return result;
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
      providerDiagnostic: RedactedProviderDiagnostic | undefined,
    ) => {
      const failure = {
        failureId: Bun.randomUUIDv7(),
        status: "error",
        ...(providerDiagnostic === undefined ? {} : { providerDiagnostic }),
      } as const;
      const result = await command({
        name: "SET",
        key: keyFor(scope),
        value: JSON.stringify(failure),
      });
      return result.map(() => undefined);
    },
    clear: async (scope: AnalysisFailureScope, expectedFailureId: string) =>
      (
        await command({
          name: "clear",
          key: keyFor(scope),
          expected: expectedFailureId,
        })
      ).map((removed) => removed === 1),
    read: async (scope: AnalysisFailureScope) => {
      const result = await command({ name: "GET", key: keyFor(scope) });
      if (Result.isError(result)) {
        return Result.err(result.error);
      }
      if (result.value === null) {
        return Result.ok(null);
      }
      if (typeof result.value !== "string") {
        return Result.err(
          new AnalysisFailureStoreError({
            message: "Invalid analysis failure delivery",
          }),
        );
      }
      const reply = result.value;
      const decoded = Result.try((): unknown => JSON.parse(reply));
      if (decoded.isErr()) {
        return Result.err(
          new AnalysisFailureStoreError({
            message: "Invalid analysis failure delivery",
          }),
        );
      }
      const parsed = v.safeParse(failureSchema, decoded.value);
      if (!parsed.success) {
        return Result.err(
          new AnalysisFailureStoreError({
            message: "Invalid analysis failure delivery",
          }),
        );
      }
      return Result.ok(parsed.output);
    },
  };
};

let store: ReturnType<typeof createAnalysisFailureStore> | undefined;
export const analysisFailureStore = () => {
  store ??= createAnalysisFailureStore();
  return store;
};
