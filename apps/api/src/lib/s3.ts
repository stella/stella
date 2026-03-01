import { S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { S3Client } from "bun";

import { env } from "@/api/env";

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
