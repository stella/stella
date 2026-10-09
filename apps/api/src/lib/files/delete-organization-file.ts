import { Result } from "better-result";

import { chunk as chunkItems } from "@stll/concurrency/chunk";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import { OrganizationFileUsageError } from "@/api/lib/files/organization-file-usage";
import { deleteS3ObjectWithSignal } from "@/api/lib/s3";

type DeleteOrganizationFileOptions = {
  fileUsageDb?: Pick<MaintenanceDb, "transaction">;
};

const DELETE_CONCURRENCY = 50;
const DELETE_CHUNK_TIMEOUT_MS = 30_000;

/** Settle confirmed deletes together; failed or timed-out keys remain accounted. */
export const deleteOrganizationFilesWithSignal = async (
  keys: string[],
  signal: AbortSignal,
  { fileUsageDb }: DeleteOrganizationFileOptions = {},
): Promise<Result<void, OrganizationFileUsageError>> => {
  const uniqueKeys = [...new Set(keys)];
  const failures: unknown[] = [];
  const { removeOrganizationFilesBytes } =
    await import("@/api/lib/files/organization-file-usage");
  for (const chunk of chunkItems(uniqueKeys, DELETE_CONCURRENCY)) {
    const deletedKeys: string[] = [];
    const chunkSignal = AbortSignal.any([
      signal,
      AbortSignal.timeout(DELETE_CHUNK_TIMEOUT_MS),
    ]);
    const results = await Promise.allSettled(
      chunk.map(async (key) => {
        await deleteS3ObjectWithSignal(key, chunkSignal);
        deletedKeys.push(key);
      }),
    );
    const removed = await removeOrganizationFilesBytes(
      deletedKeys,
      fileUsageDb,
    );
    if (Result.isError(removed)) {
      return Result.err(removed.error);
    }
    for (const result of results) {
      if (result.status === "rejected") {
        failures.push(result.reason);
      }
    }
  }
  if (failures.length > 0) {
    return Result.err(
      new OrganizationFileUsageError({
        message: "Organization files could not be deleted",
        reason: "storage_unavailable",
        cause: failures.at(0),
      }),
    );
  }
  return Result.ok(undefined);
};

/** Delete a stored organization file, then remove its committed byte count. */
export const deleteOrganizationFileWithSignal = async (
  key: string,
  signal: AbortSignal,
  { fileUsageDb }: DeleteOrganizationFileOptions = {},
): Promise<Result<void, OrganizationFileUsageError>> => {
  await deleteS3ObjectWithSignal(key, signal);
  if (!envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS) {
    return Result.ok(undefined);
  }
  const { removeOrganizationFileBytes } =
    await import("@/api/lib/files/organization-file-usage");
  return await removeOrganizationFileBytes(key, fileUsageDb);
};
