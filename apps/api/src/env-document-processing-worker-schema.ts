import * as v from "valibot";

import { RUNTIME_MODE, type RuntimeMode } from "@stll/runtime-mode";

import { featureFlagSchema } from "@/api/env-base-schema";

/**
 * One switch for every background writer a process hosts: the scheduler and
 * each queue worker its host starts (see `createBullMqWorkerHost`). Seeded
 * local stacks turn it off so nothing writes after the seed; whatever a worker
 * would derive from the seeded rows must come from the seed itself.
 */
export const scheduledJobsModeSchema = v.optional(
  v.picklist(["enabled", "disabled"]),
  "enabled",
);

/**
 * Environment shared by the API process and document-processing worker.
 * Keeping this boundary separate lets the worker boot without validating
 * unrelated HTTP-server concerns such as auth, email, and Gotenberg.
 */
export const envDocumentProcessingWorkerServerSchema = {
  SCHEDULED_JOBS_MODE: scheduledJobsModeSchema,
  FEATURE_INBOX_DOCUMENT_SCOUTS: featureFlagSchema,
  FEATURE_FILE_USAGE_LIMITS: featureFlagSchema,
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
  redisUrl: string | undefined;
  runtimeMode: RuntimeMode;
  scheduledJobsMode: v.InferOutput<typeof scheduledJobsModeSchema>;
};

/**
 * REDIS_URL is declared in the base schema and optional there, so a process
 * that runs with the base environment only never has to supply one. Both
 * entrypoints validated here queue and broadcast over Redis, so for them its
 * absence is a configuration error rather than an unused setting.
 */
export const documentProcessingEnvInvariantViolation = ({
  contentEncryptionKey,
  redisUrl,
  runtimeMode,
  scheduledJobsMode,
}: DocumentProcessingEnvInvariantInput): string | null => {
  if (
    scheduledJobsMode === "disabled" &&
    runtimeMode.mode !== RUNTIME_MODE.open
  ) {
    return "SCHEDULED_JOBS_MODE=disabled is only supported in local development and tests.";
  }
  if (redisUrl === undefined) {
    return "REDIS_URL is required by the API server and the document-processing worker.";
  }
  if (runtimeMode.mode !== RUNTIME_MODE.open && !contentEncryptionKey) {
    return "CONTENT_ENCRYPTION_KEY is required outside local development.";
  }
  return null;
};
