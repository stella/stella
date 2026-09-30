import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { redisConnectionConfig } from "@stll/redis-config";
import { readRuntimeMode } from "@stll/runtime-mode";

import {
  collabEnvInvariantViolation,
  envCollabServerSchema,
} from "./env-schema";

const validatedEnv = createEnv({
  server: envCollabServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});

const invariantViolation = collabEnvInvariantViolation({
  mode: validatedEnv.STELLA_COLLAB_MODE,
  redisUrl: validatedEnv.STELLA_COLLAB_REDIS_URL,
  runtimeMode: readRuntimeMode().runtimeMode,
});
if (invariantViolation !== null) {
  panic(invariantViolation);
}

if (
  validatedEnv.STELLA_COLLAB_MODE === "redis" &&
  validatedEnv.STELLA_COLLAB_REDIS_URL !== undefined
) {
  const { mode } = redisConnectionConfig({
    url: validatedEnv.STELLA_COLLAB_REDIS_URL,
    settings: validatedEnv,
    rejectUnauthorized: validatedEnv.REDIS_TLS_REJECT_UNAUTHORIZED,
  });
  process.stdout.write(
    `${JSON.stringify({ event: "redis.connection.mode", mode })}\n`,
  );
}

export const env = validatedEnv;
