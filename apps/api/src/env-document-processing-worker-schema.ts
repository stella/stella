import * as v from "valibot";

import { DEPLOYED_NODE_ENVS, featureFlagSchema } from "@/api/env-base-schema";

/**
 * Environment shared by the API process and document-processing worker.
 * Keeping this boundary separate lets the worker boot without validating
 * unrelated HTTP-server concerns such as auth, email, and Gotenberg.
 */
export const envDocumentProcessingWorkerServerSchema = {
  FEATURE_INBOX_DOCUMENT_SCOUTS: featureFlagSchema,
  DOCUMENT_OCR_MODEL_DIR: v.optional(v.string()),
  /**
   * Batch mode: exit once the processing queue has been empty this many
   * minutes. Unset keeps the worker long-running.
   */
  DOCUMENT_PROCESSING_IDLE_EXIT_MINUTES: v.optional(
    v.pipe(v.string(), v.toNumber(), v.integer(), v.minValue(1)),
  ),
  CONTENT_ENCRYPTION_KEY: v.optional(
    v.pipe(
      v.string(),
      v.regex(
        /^[0-9a-f]{64}$/iu,
        "CONTENT_ENCRYPTION_KEY must be a 64-character hex string",
      ),
    ),
  ),
};

type DocumentProcessingEnvInvariantInput = {
  contentEncryptionKey: string | undefined;
  nodeEnv: string | undefined;
  redisUrl: string | undefined;
};

/**
 * REDIS_URL is declared in the base schema and optional there, so a process
 * that runs with the base environment only never has to supply one. Both
 * entrypoints validated here queue and broadcast over Redis, so for them its
 * absence is a configuration error rather than an unused setting.
 */
export const documentProcessingEnvInvariantViolation = ({
  contentEncryptionKey,
  nodeEnv,
  redisUrl,
}: DocumentProcessingEnvInvariantInput): string | null => {
  if (redisUrl === undefined) {
    return "REDIS_URL is required by the API server and the document-processing worker.";
  }
  if (DEPLOYED_NODE_ENVS.has(nodeEnv ?? "") && !contentEncryptionKey) {
    return "CONTENT_ENCRYPTION_KEY is required when NODE_ENV is 'production' or 'staging'.";
  }
  return null;
};
