import { GetObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";

declare const db: { transaction: (work: () => Promise<void>) => Promise<void> };
declare const s3: S3Client;

export const rejected = async () => {
  await db.transaction(async () => {
    // oxlint-disable-next-line no-network-in-transaction/no-network-in-transaction -- fixture: remote I/O is intentionally inside the transaction
    await s3.send(new GetObjectCommand({ Bucket: "bucket", Key: "key" }));
  });
};

export const accepted = async () => {
  // expect-clean: no-network-in-transaction/no-network-in-transaction
  const response = await fetch("https://example.test");
  await db.transaction(async () => {
    await Promise.resolve(response.body);
  });
};
