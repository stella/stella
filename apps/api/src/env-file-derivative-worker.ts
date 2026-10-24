import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { envBase } from "@/api/env-base";
import {
  envFileDerivativeWorkerServerSchema,
  fileDerivativeWorkerEnvInvariantViolation,
} from "@/api/env-file-derivative-worker-schema";
import { resolveConfigurationPlaceholders } from "@/api/lib/configuration-placeholders";
import { runtimeMode } from "@/api/runtime-mode";

const workerRuntimeEnv = resolveConfigurationPlaceholders({
  schema: envFileDerivativeWorkerServerSchema,
  values: process.env,
});
if (workerRuntimeEnv.violation !== null) {
  panic(workerRuntimeEnv.violation);
}

const specific = createEnv({
  server: envFileDerivativeWorkerServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: workerRuntimeEnv.runtimeEnv,
});
const violation = fileDerivativeWorkerEnvInvariantViolation({
  gotenbergUrl: specific.GOTENBERG_URL,
  redisUrl: envBase.REDIS_URL,
  runtimeMode: runtimeMode(),
  scheduledJobsMode: specific.SCHEDULED_JOBS_MODE,
});
if (violation !== null) {
  panic(violation);
}

export const envFileDerivativeWorker = { ...envBase, ...specific };
