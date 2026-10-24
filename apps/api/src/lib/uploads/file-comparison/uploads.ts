import { Temporal } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import { FILE_READ_URL_EXPIRY_SECONDS } from "@/api/lib/files/read-file";

/**
 * How long a staged input stays usable. The presigned PUT is good for far
 * less; this is the window the comparison itself has to run in, from the call
 * that reserved the pair to the call that reads it.
 */
export const FILE_COMPARISON_INPUT_TTL_SECONDS = 60 * 60;

/**
 * One claim spans two bounded reads, scans, comparison and delivery. Each
 * external stage has its own shorter timeout; five minutes leaves room for
 * scheduling delay while still making a crashed invocation retryable.
 */
export const FILE_COMPARISON_CLAIM_TTL_MS = 5 * 60 * 1000;

/**
 * Reservations keep counting until object-before-row cleanup succeeds. The
 * row limit bounds tiny-file churn, while the byte limit bounds signed object
 * capacity. The organization-scoped lock in the reservation transaction makes
 * both the caller and organization limits safe under concurrent prepares.
 */
export const FILE_COMPARISON_OUTSTANDING_ROW_LIMIT = 100;
export const FILE_COMPARISON_OUTSTANDING_BYTE_LIMIT = 1024 * 1024 * 1024;
export const FILE_COMPARISON_ORGANIZATION_OUTSTANDING_ROW_LIMIT = 500;
export const FILE_COMPARISON_ORGANIZATION_OUTSTANDING_BYTE_LIMIT =
  5 * 1024 * 1024 * 1024;

/**
 * How long the redline stays downloadable. It is the download URL's own
 * lifetime: once the link is dead the object is unreachable, so keeping the
 * object would keep bytes nothing can name.
 */
export const FILE_COMPARISON_REDLINE_TTL_SECONDS = FILE_READ_URL_EXPIRY_SECONDS;

/**
 * Where one comparison object lives. The organization leads the key, as every
 * tenant object's key does, and `tmp/` marks bytes that are never promoted
 * into matter storage.
 */
export const fileComparisonObjectKey = ({
  organizationId,
  uploadId,
}: {
  organizationId: SafeId<"organization">;
  uploadId: SafeId<"fileComparisonUpload">;
}): string => `${organizationId}/tmp/comparisons/${uploadId}`;

export const fileComparisonExpiry = (ttlSeconds: number): Date =>
  new Date(
    Temporal.Now.instant().add({ seconds: ttlSeconds }).epochMilliseconds,
  );
