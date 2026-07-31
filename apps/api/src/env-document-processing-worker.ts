import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";
import * as v from "valibot";

import { DEPLOYED_NODE_ENVS, envBase } from "@/api/env-base";

const isSecureOcrServiceUrl = (value: string) => {
  const url = new URL(value);
  if (url.protocol === "https:") {
    return true;
  }
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  );
};

/**
 * Environment shared by the API process and document-processing worker.
 * Keeping this boundary separate lets the worker boot without validating
 * unrelated HTTP-server concerns such as auth, email, and Gotenberg.
 */
const envDocumentProcessingWorkerSpecific = createEnv({
  server: {
    REDIS_URL: v.pipe(v.string(), v.url()),
    OCR_SERVICE_URL: v.optional(
      v.pipe(
        v.string(),
        v.url(),
        v.check(
          isSecureOcrServiceUrl,
          "OCR_SERVICE_URL must use HTTPS unless it targets a loopback address.",
        ),
      ),
    ),
    OCR_SERVICE_TOKEN: v.optional(v.pipe(v.string(), v.minLength(16))),
    CONTENT_ENCRYPTION_KEY: v.optional(
      v.pipe(
        v.string(),
        v.regex(
          /^[0-9a-f]{64}$/iu,
          "CONTENT_ENCRYPTION_KEY must be a 64-character hex string",
        ),
      ),
    ),
  },
  emptyStringAsUndefined: true,
  runtimeEnv: process.env,
});

if (
  DEPLOYED_NODE_ENVS.has(process.env.NODE_ENV ?? "") &&
  !envDocumentProcessingWorkerSpecific.CONTENT_ENCRYPTION_KEY
) {
  panic(
    "CONTENT_ENCRYPTION_KEY is required when NODE_ENV is 'production' or 'staging'.",
  );
}

export const envDocumentProcessingWorker = {
  ...envBase,
  ...envDocumentProcessingWorkerSpecific,
};
