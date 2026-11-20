import { panic } from "better-result";
import { sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
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

type OutstandingCapacityRow = {
  organization_bytes: number;
  organization_rows: number;
  user_bytes: number;
  user_rows: number;
};

/**
 * Retained comparison capacity of the transaction's organization and member.
 * Row policies show a member only their own rows, so the totals come from the
 * database census, which takes both scopes from the transaction settings and
 * returns no row. Callers hold the organization's capacity lock first.
 */
export const readOutstandingFileComparisonCapacity = async (
  tx: Pick<Transaction, "execute">,
) => {
  const rows = await tx.execute<OutstandingCapacityRow>(
    sql`SELECT organization_rows, organization_bytes, user_rows, user_bytes FROM public.file_comparison_outstanding_capacity()`,
  );
  const totals =
    rows.at(0) ?? panic("Comparison reservation census returned no row");
  return {
    organizationBytes: totals.organization_bytes,
    organizationRows: totals.organization_rows,
    userBytes: totals.user_bytes,
    userRows: totals.user_rows,
  };
};

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
