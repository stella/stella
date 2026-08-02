import { createEnv } from "@t3-oss/env-core";
import { panic } from "better-result";

import { DEPLOYED_NODE_ENVS, envBase } from "@/api/env-base";
import { envDocumentProcessingWorkerServerSchema } from "@/api/env-document-processing-worker-schema";

const envDocumentProcessingWorkerSpecific = createEnv({
  server: envDocumentProcessingWorkerServerSchema,
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
