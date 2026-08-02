import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { envApiServerSchema } from "@/api/env-schema";

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

if (
  (envApi.MICROSOFT_AUTH_CLIENT_ID || envApi.MICROSOFT_AUTH_CLIENT_SECRET) &&
  !envApi.MICROSOFT_AUTH_TENANT_ID
) {
  panic(
    "MICROSOFT_AUTH_TENANT_ID is required when Microsoft OAuth is configured.",
  );
}

export const env = { ...envDocumentProcessingWorker, ...envApi };

// Prevent accidental mutation of env vars at runtime.
// Must run AFTER createEnv has consumed process.env.
if (process.env.NODE_ENV === "production") {
  Object.freeze(process.env);
}
