import { RUNTIME_MODE, type RuntimeMode } from "@stll/runtime-mode";

import { converterSettingsSchema } from "@/api/lib/files/converter-settings";
import { isSecureGotenbergUrl } from "@/api/lib/secure-service-url";

export const envFileDerivativeWorkerServerSchema = converterSettingsSchema;

export const fileDerivativeWorkerEnvInvariantViolation = ({
  gotenbergUrl,
  redisUrl,
  runtimeMode,
}: {
  gotenbergUrl: string;
  redisUrl: string | undefined;
  runtimeMode: RuntimeMode;
}): string | null => {
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
