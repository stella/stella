import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

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

export const env = validatedEnv;
