import { DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { Result, TaggedError } from "better-result";

import { env } from "@/api/env";
import type { SafeId } from "@/api/lib/branded-types";
import { awsS3 } from "@/api/lib/s3";

export const PDF_MIME_TYPE = "application/pdf" as const;

const fileExtensionMap: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "application/zip": "zip",
  "application/json": "json",
  "application/xml": "xml",
  "message/rfc822": "eml",
  "application/vnd.ms-outlook": "msg",
  "application/rtf": "rtf",
};

const getFileExtension = (mimeType: string): string =>
  fileExtensionMap[mimeType] ?? "bin";

type CreateFileKeyProps = {
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  fileId: string;
  mimeType: string;
};

export const createFileKey = ({
  organizationId,
  workspaceId,
  fileId,
  mimeType,
}: CreateFileKeyProps) =>
  `${organizationId}/${workspaceId}/${fileId}.${getFileExtension(mimeType)}`;

/** S3 DeleteObjects supports up to 1000 keys per request. */
const S3_DELETE_BATCH_SIZE = 1000;

type DeleteS3ObjectsProps = {
  fileRows: { fileId: string; mimeType: string }[];
  organizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
};

export class S3Error extends TaggedError("S3Error")<{
  message: string;
  code?: string;
  key?: string;
  cause?: unknown;
}>() {}

export const deleteS3Objects = async ({
  fileRows,
  organizationId,
  workspaceId,
}: DeleteS3ObjectsProps): Promise<Result<void, Error>> => {
  for (let i = 0; i < fileRows.length; i += S3_DELETE_BATCH_SIZE) {
    const batch = fileRows.slice(i, i + S3_DELETE_BATCH_SIZE);

    const result = await Result.tryPromise(() =>
      awsS3.send(
        new DeleteObjectsCommand({
          Bucket: env.S3_BUCKET,
          Delete: {
            Objects: batch.map(({ fileId, mimeType }) => ({
              Key: createFileKey({
                organizationId,
                workspaceId,
                fileId,
                mimeType,
              }),
            })),
            Quiet: true,
          },
        }),
      ),
    );

    if (Result.isError(result)) {
      return result;
    }

    const error = result.value.Errors?.at(0);

    if (error) {
      return Result.err(
        new S3Error({
          message: "Failed to delete S3 objects",
          code: error.Code,
          key: error.Key,
          cause: error,
        }),
      );
    }
  }

  return Result.ok();
};
