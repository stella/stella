import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import { resolveConfigurationPlaceholders } from "@/api/lib/configuration-placeholders";
import { converterSettingsSchema } from "@/api/lib/files/converter-settings";
import { isSecureGotenbergUrl } from "@/api/lib/secure-service-url";
import { runtimeMode } from "@/api/runtime-mode";

const configured = resolveConfigurationPlaceholders({
  schema: converterSettingsSchema,
  values: process.env,
});
if (configured.violation !== null) {
  panic(configured.violation);
}

const converter = createEnv({
  server: converterSettingsSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: configured.runtimeEnv,
});
if (
  runtimeMode().mode !== RUNTIME_MODE.open &&
  !isSecureGotenbergUrl(converter.GOTENBERG_URL)
) {
  panic(
    "GOTENBERG_URL must use HTTPS unless it targets a loopback address or a private deployment network.",
  );
}

export const envConverter = converter;
