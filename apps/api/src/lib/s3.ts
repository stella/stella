import { S3Client as AwsS3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client } from "bun";

import { env } from "@/api/env";
import { contentDisposition } from "@/api/lib/content-disposition";

export const s3 = new S3Client({
  acl: "private",
  bucket: env.S3_BUCKET,
  endpoint: env.S3_ENDPOINT,
  accessKeyId: env.S3_ACCESS_KEY_ID,
  secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  region: env.S3_REGION,
});

export const awsS3 = new AwsS3Client({
  forcePathStyle: true,
  endpoint: env.S3_ENDPOINT,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
  region: env.S3_REGION,
});

/**
 * Generate a presigned GET URL that forces the browser to
 * download the file instead of rendering it inline. Uses the
 * AWS SDK because Bun's S3Client.presign does not support
 * response override parameters.
 *
 * Filenames are sanitized at upload time. RFC 6266 encoding
 * is applied here for non-ASCII characters.
 */
export const presignDownloadUrl = async (
  key: string,
  options: { expiresIn: number; fileName: string },
) =>
  await getSignedUrl(
    awsS3,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: contentDisposition(options.fileName),
    }),
    { expiresIn: options.expiresIn },
  );
