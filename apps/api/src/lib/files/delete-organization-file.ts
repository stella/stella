import { Result } from "better-result";

import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import type { OrganizationFileUsageError } from "@/api/lib/files/organization-file-usage";
import { deleteS3ObjectWithSignal } from "@/api/lib/s3";

type DeleteOrganizationFileOptions = {
  fileUsageDb?: Pick<MaintenanceDb, "transaction">;
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
