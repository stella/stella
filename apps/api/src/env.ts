import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";
import { existsSync, statSync } from "node:fs";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import {
  envApiInvariantViolation,
  envApiServerSchema,
  resolveEmailProvider,
} from "@/api/env-schema";
import { resolveConfigurationPlaceholders } from "@/api/lib/configuration-placeholders";

const apiRuntimeEnv = resolveConfigurationPlaceholders({
  schema: envApiServerSchema,
  values: process.env,
});
if (apiRuntimeEnv.violation !== null) {
  panic(apiRuntimeEnv.violation);
}

/**
 * API-specific environment variables. These are only required when the full
 * API server boots. The side-effect-free schema lives in env-schema.ts so
 * repository tooling can inspect it without initializing the application.
 */
const envApi = createEnv({
  server: envApiServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: apiRuntimeEnv.runtimeEnv,
});

const emailProvider = resolveEmailProvider(envApi);
const invariantViolation = envApiInvariantViolation({
  ...envApi,
  EMAIL_PROVIDER: emailProvider,
  nodeEnv: process.env.NODE_ENV,
});
if (invariantViolation !== null) {
  panic(invariantViolation);
}
if (
  envApi.REPORT_SPECS_DIR !== undefined &&
  !(
    existsSync(envApi.REPORT_SPECS_DIR) &&
    statSync(envApi.REPORT_SPECS_DIR).isDirectory()
  )
) {
  panic(
    `REPORT_SPECS_DIR does not point at a directory: ${envApi.REPORT_SPECS_DIR}`,
  );
}

const validatedEnv = {
  ...envDocumentProcessingWorker,
  ...envApi,
  EMAIL_PROVIDER: emailProvider,
};

// Bun owns process.env and may expose it through a runtime proxy. Freeze the
// validated application boundary instead of mutating the runtime object.
if (process.env.NODE_ENV === "production") {
  Object.freeze(validatedEnv);
}

export const env = validatedEnv;
