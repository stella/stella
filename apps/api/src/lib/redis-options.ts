/**
 * Per-driver Redis connection options.
 *
 * `rediss://` negotiates an encrypted channel; whether the certificate chain
 * is verified is a deployment question, not a driver one. Verification is on
 * by default and `REDIS_TLS_REJECT_UNAUTHORIZED=false` turns it off, for an
 * endpoint whose certificate no trust anchor can validate (a self-signed
 * certificate bound to a private address) and where the network is the
 * boundary instead.
 */

import type { RedisOptions } from "bun";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";

export const redisConnectionOptions = (
  url = envDocumentProcessingWorker.REDIS_URL,
  rejectUnauthorized = envDocumentProcessingWorker.REDIS_TLS_REJECT_UNAUTHORIZED,
): RedisOptions => {
  const useTls = url.toLowerCase().startsWith("rediss://");
  return useTls ? { tls: { rejectUnauthorized } } : {};
};
