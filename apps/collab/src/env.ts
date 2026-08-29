import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

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
  nodeEnv: process.env.NODE_ENV,
  redisUrl: validatedEnv.STELLA_COLLAB_REDIS_URL,
});
if (invariantViolation !== null) {
  panic(invariantViolation);
}

export const env = validatedEnv;
