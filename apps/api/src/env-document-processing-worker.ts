import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { envBase } from "@/api/env-base";
import {
  documentProcessingEnvInvariantViolation,
  envDocumentProcessingWorkerServerSchema,
} from "@/api/env-document-processing-worker-schema";
import { resolveConfigurationPlaceholders } from "@/api/lib/configuration-placeholders";

const workerRuntimeEnv = resolveConfigurationPlaceholders({
  schema: envDocumentProcessingWorkerServerSchema,
  values: process.env,
});
if (workerRuntimeEnv.violation !== null) {
  panic(workerRuntimeEnv.violation);
}

const envDocumentProcessingWorkerSpecific = createEnv({
  server: envDocumentProcessingWorkerServerSchema,
  emptyStringAsUndefined: true,
  runtimeEnv: workerRuntimeEnv.runtimeEnv,
});

const invariantViolation = documentProcessingEnvInvariantViolation({
  contentEncryptionKey:
    envDocumentProcessingWorkerSpecific.CONTENT_ENCRYPTION_KEY,
  nodeEnv: process.env.NODE_ENV,
  redisUrl: envDocumentProcessingWorkerSpecific.REDIS_URL,
});
if (invariantViolation !== null) {
  panic(invariantViolation);
}

export const envDocumentProcessingWorker = {
  ...envBase,
  ...envDocumentProcessingWorkerSpecific,
};
