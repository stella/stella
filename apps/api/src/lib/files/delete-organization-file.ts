import { Result, TaggedError } from "better-result";
import { eq, sql } from "drizzle-orm";

import { chunk as chunkItems } from "@stll/concurrency/chunk";
import { declareFingerprintFields } from "@stll/errors";

import { organization } from "@/api/db/auth-schema";
import { chatThreads, userFiles } from "@/api/db/schema";
import { envDocumentProcessingWorker } from "@/api/env-document-processing-worker";
import { withAggregateTransaction } from "@/api/lib/db/aggregate-lock";
import type { MaintenanceDb } from "@/api/lib/db/maintenance-db";
import { OrganizationFileUsageError } from "@/api/lib/files/organization-file-usage";
import { LegalHoldActiveError } from "@/api/lib/legal-holds/errors";
import { requireNoHold } from "@/api/lib/legal-holds/holds";
import { deleteS3ObjectWithSignal } from "@/api/lib/s3";
import { brandPersistedOrganizationId } from "@/api/lib/safe-id-boundaries";

type DeleteOrganizationFileOptions = {
  fileUsageDb?: Pick<MaintenanceDb, "transaction">;
};

export class DeleteOrganizationFileError extends TaggedError(
  "DeleteOrganizationFileError",
)<{
  message: string;
  stage: "storage" | "usage_removal";
  cause: OrganizationFileUsageError;
}> {
  static {
    declareFingerprintFields(this, ["stage"]);
  }
}

const DELETE_CONCURRENCY = 50;
const DELETE_CHUNK_TIMEOUT_MS = 30_000;

/** Settle confirmed deletes together; failed or timed-out keys remain accounted. */
export const deleteOrganizationFilesWithSignal = async (
  keys: string[],
  signal: AbortSignal,
  { fileUsageDb }: DeleteOrganizationFileOptions = {},
): Promise<Result<void, OrganizationFileUsageError | LegalHoldActiveError>> => {
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
    const checked = await deleteUnheldObjectChunk({
      keys: chunk,
      signal: chunkSignal,
      fileUsageDb,
    });
    if (checked.isErr()) {
      return Result.err(checked.error);
    }
    const results = checked.value;
    for (const result of results) {
      if (result.status === "fulfilled") {
        deletedKeys.push(result.value);
      }
    }
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
): Promise<
  Result<void, DeleteOrganizationFileError | LegalHoldActiveError>
> => {
  const checked = await deleteUnheldObjectChunk({
    keys: [key],
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(DELETE_CHUNK_TIMEOUT_MS),
    ]),
    fileUsageDb,
  });
  if (checked.isErr()) {
    return LegalHoldActiveError.is(checked.error)
      ? Result.err(checked.error)
      : Result.err(
          new DeleteOrganizationFileError({
            message: "Organization files could not be deleted",
            stage: "storage",
            cause: checked.error,
          }),
        );
  }
  const deletion = checked.value.at(0);
  if (deletion?.status === "rejected") {
    return Result.err(
      new DeleteOrganizationFileError({
        message: "Organization files could not be deleted",
        stage: "storage",
        cause: new OrganizationFileUsageError({
          message: "Organization files could not be deleted",
          reason: "storage_unavailable",
          cause: deletion.reason,
        }),
      }),
    );
  }
  if (!envDocumentProcessingWorker.FEATURE_FILE_USAGE_LIMITS) {
    return Result.ok(undefined);
  }
  const { removeOrganizationFileBytes } =
    await import("@/api/lib/files/organization-file-usage");
  const removed = await removeOrganizationFileBytes(key, fileUsageDb);
  if (Result.isError(removed)) {
    return Result.err(
      new DeleteOrganizationFileError({
        message: "Organization file usage could not be removed",
        stage: "usage_removal",
        cause: removed.error,
      }),
    );
  }
  return Result.ok();
};

type DeleteUnheldObjectChunkOptions = {
  keys: string[];
  signal: AbortSignal;
  fileUsageDb: DeleteOrganizationFileOptions["fileUsageDb"];
};

// Keep the legal-hold fence until the storage request settles: a hold placed
// after a successful delete cannot claim bytes that were already withdrawn.
const deleteUnheldObjectChunk = async ({
  keys,
  signal,
  fileUsageDb,
}: DeleteUnheldObjectChunkOptions) => {
  const { openOrganizationFileUsageDb } =
    await import("@/api/lib/db/maintenance-db");
  return await Result.tryPromise({
    try: async () =>
      await withAggregateTransaction(
        fileUsageDb ?? openOrganizationFileUsageDb(),
        async (tx) => {
          const prefixes = [
            ...new Set(
              keys
                .map((key) => key.split("/").at(0))
                .filter((prefix) => prefix !== undefined),
            ),
          ];
          const keyOwners = await tx
            .select({ id: organization.id })
            .from(organization)
            .where(
              sql`${organization.id} = ANY(ARRAY[${sql.join(
                prefixes.map((prefix) => sql`${prefix}`),
                sql`, `,
              )}]::text[])`,
            );
          const attachmentOwners = await tx
            .selectDistinct({ id: chatThreads.organizationId })
            .from(userFiles)
            .innerJoin(chatThreads, eq(chatThreads.id, userFiles.threadId))
            .innerJoin(
              sql`unnest(ARRAY[${sql.join(
                keys.map((key) => sql`${key}`),
                sql`, `,
              )}]::text[]) requested_keys(object_key)`,
              sql`${userFiles.s3Key} = requested_keys.object_key OR (${userFiles.thumbnailFileId} = split_part(split_part(requested_keys.object_key, '/', 2), '.', 1) AND (split_part(requested_keys.object_key, '/', 1) = ${userFiles.userId} OR split_part(requested_keys.object_key, '/', 1) = ${chatThreads.organizationId}))`,
            );
          const organizationIds = [
            ...new Set([...keyOwners, ...attachmentOwners].map(({ id }) => id)),
          ].toSorted();
          for (const organizationId of organizationIds) {
            const hold = await requireNoHold({
              tx,
              organizationId: brandPersistedOrganizationId(organizationId),
              target: { type: "files", objectKeys: keys },
            });
            if (hold.isErr()) {
              return Result.err(hold.error);
            }
          }
          return Result.ok(
            await Promise.allSettled(
              keys.map(async (key) => {
                await deleteS3ObjectWithSignal(key, signal);
                return key;
              }),
            ),
          );
        },
      ),
    catch: (cause) =>
      new OrganizationFileUsageError({
        message: "Organization files could not be deleted",
        reason: "storage_unavailable",
        cause,
      }),
  }).then((outcome) => outcome.andThen((checked) => checked));
};
