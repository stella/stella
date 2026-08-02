import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import {
  envApiInvariantViolation,
  envApiServerSchema,
  resolveEmailProvider,
} from "@/api/env-schema";

/**
 * API-specific environment variables. These are only required when the full
 * API server boots. The side-effect-free schema lives in env-schema.ts so
 * repository tooling can inspect it without initializing the application.
 */
const envApi = createEnv({
  server: envApiServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
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

export const env = {
  ...envDocumentProcessingWorker,
  ...envApi,
  EMAIL_PROVIDER: emailProvider,
};

// Prevent accidental mutation of env vars at runtime.
// Must run AFTER createEnv has consumed process.env.
if (process.env.NODE_ENV === "production") {
  Object.freeze(process.env);
}
