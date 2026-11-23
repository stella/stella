import { Result, TaggedError } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import {
  createFileKey,
  createOcrSearchablePdfKey,
  createUserFileKey,
  getFileExtension,
} from "@/api/lib/file-key";
import { deleteOrganizationFilesWithSignal } from "@/api/lib/files/delete-organization-file";

export {
  createFileKey,
  createOcrSearchablePdfKey,
  createUserFileKey,
  getFileExtension,
};

type DeleteS3ObjectsProps = {
  fileRows: { fileId: string; mimeType: string }[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

class S3Error extends TaggedError("S3Error")<{
  message: string;
  code?: string | undefined;
  key?: string | undefined;
  cause?: unknown;
}> {}

export const deleteS3Objects = async ({
  fileRows,
  organizationId,
  workspaceId,
}: DeleteS3ObjectsProps): Promise<Result<void, S3Error>> => {
  const keys = fileRows.map(({ fileId, mimeType }) =>
    createFileKey({
      organizationId,
      workspaceId,
      fileId,
      mimeType,
    }),
  );

  return await deleteS3Keys(keys);
};

export const deleteS3Keys = async (
  keys: string[],
  signal = new AbortController().signal,
): Promise<Result<void, S3Error>> => {
  const deleted = await deleteOrganizationFilesWithSignal(keys, signal);
  if (Result.isError(deleted)) {
    return Result.err(
      new S3Error({
        message: "Failed to delete S3 objects",
        key: keys.at(0),
        cause: deleted.error,
      }),
    );
  }
  return Result.ok();
};
