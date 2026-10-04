import type { writeScannedObject } from "@/api/lib/file-scan/stored-object";
import type {
  S3ObjectWriteOwnership,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";

type RequiredOwnership<T> = undefined extends T ? false : true;
const directOwnershipRequired = true satisfies RequiredOwnership<
  Parameters<typeof writeS3ObjectWithRetry>[1]
>;
const scannedOwnershipRequired = true satisfies RequiredOwnership<
  Parameters<typeof writeScannedObject>[1]
>;
const directAndScannedMatch = true satisfies Parameters<
  typeof writeScannedObject
>[1] extends S3ObjectWriteOwnership
  ? true
  : false;
export const ownershipContract = {
  directOwnershipRequired,
  scannedOwnershipRequired,
  directAndScannedMatch,
};
