import * as v from "valibot";

import { DEPLOYED_NODE_ENVS, featureFlagSchema } from "@/api/env-base-schema";
import {
  isRailwayPrivateHostname,
  isTlsOrLoopbackUrl,
} from "@/api/lib/secure-service-url";

const isSecureRedisUrl = (value: string) => {
  const url = new URL(value);
  return (
    isTlsOrLoopbackUrl(value, {
      plaintextProtocol: "redis:",
      tlsProtocol: "rediss:",
    }) ||
    (url.protocol === "redis:" && isRailwayPrivateHostname(url.hostname))
  );
};

/**
 * Environment shared by the API process and document-processing worker.
 * Keeping this boundary separate lets the worker boot without validating
 * unrelated HTTP-server concerns such as auth, email, and Gotenberg.
 */
export const envDocumentProcessingWorkerServerSchema = {
  REDIS_URL: v.pipe(v.string(), v.url()),
  /**
   * Whether a `rediss://` connection verifies the server's certificate chain.
   * On by default. Set to false only where the endpoint presents a
   * certificate no trust anchor can validate — a self-signed certificate
   * bound to a private address, say — and the network itself is the boundary.
   */
  REDIS_TLS_REJECT_UNAUTHORIZED: v.optional(
    v.pipe(v.string(), v.parseBoolean()),
    "true",
  ),
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
  redisUrl: string;
};

export const documentProcessingEnvInvariantViolation = ({
  contentEncryptionKey,
  nodeEnv,
  redisUrl,
}: DocumentProcessingEnvInvariantInput): string | null => {
  if (DEPLOYED_NODE_ENVS.has(nodeEnv ?? "") && !isSecureRedisUrl(redisUrl)) {
    return "REDIS_URL must use rediss:// unless it targets loopback or Railway private networking.";
  }
  if (DEPLOYED_NODE_ENVS.has(nodeEnv ?? "") && !contentEncryptionKey) {
    return "CONTENT_ENCRYPTION_KEY is required when NODE_ENV is 'production' or 'staging'.";
  }
  return null;
};
