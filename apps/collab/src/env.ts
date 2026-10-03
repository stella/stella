import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import {
  readRuntimeMode,
  secretExampleInvariantViolation,
} from "@stll/runtime-mode";

import {
  collabEnvInvariantViolation,
  envCollabServerSchema,
} from "./env-schema";

const runtimeMode = readRuntimeMode().runtimeMode;
const exampleViolation = secretExampleInvariantViolation({
  values: process.env,
  runtimeMode,
});
if (exampleViolation !== null) {
  panic(exampleViolation);
}

const validatedEnv = createEnv({
  server: envCollabServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});

const invariantViolation = collabEnvInvariantViolation({
  mode: validatedEnv.STELLA_COLLAB_MODE,
  redisUrl: validatedEnv.STELLA_COLLAB_REDIS_URL,
  runtimeMode,
});
if (invariantViolation !== null) {
  panic(invariantViolation);
}

export const env = validatedEnv;
