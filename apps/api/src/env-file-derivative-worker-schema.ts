import type * as v from "valibot";

import { RUNTIME_MODE, type RuntimeMode } from "@stll/runtime-mode";

import { scheduledJobsModeSchema } from "@/api/env-document-processing-worker-schema";
import { converterSettingsSchema } from "@/api/lib/files/converter-settings";
import { isSecureGotenbergUrl } from "@/api/lib/secure-service-url";

export const envFileDerivativeWorkerServerSchema = {
  ...converterSettingsSchema,
  SCHEDULED_JOBS_MODE: scheduledJobsModeSchema,
};

export const fileDerivativeWorkerEnvInvariantViolation = ({
  gotenbergUrl,
  redisUrl,
  runtimeMode,
  scheduledJobsMode,
}: {
  gotenbergUrl: string;
  redisUrl: string | undefined;
  runtimeMode: RuntimeMode;
  scheduledJobsMode: v.InferOutput<typeof scheduledJobsModeSchema>;
}): string | null => {
  if (
    scheduledJobsMode === "disabled" &&
    runtimeMode.mode !== RUNTIME_MODE.open
  ) {
    return "SCHEDULED_JOBS_MODE=disabled is only supported in local development and tests.";
  }
  if (redisUrl === undefined) {
    return "REDIS_URL is required by the file-derivative worker.";
  }
  if (
    runtimeMode.mode !== RUNTIME_MODE.open &&
    !isSecureGotenbergUrl(gotenbergUrl)
  ) {
    return "GOTENBERG_URL must use HTTPS unless it targets a loopback address or a private deployment network.";
  }
  return null;
};
