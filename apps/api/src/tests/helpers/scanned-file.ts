import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";
import { testFileKey } from "@/api/tests/helpers/file-key";

/** Fixture bytes as a stored `ScannedFile`, for tests of parser callers. */
export const testScannedFile = ({
  bytes,
  mimeType,
  path = "org/ws/fixture",
}: {
  bytes: ArrayBuffer;
  mimeType: string;
  path?: string;
}): ScannedFile =>
  mintScannedFile({
    bytes,
    fileName: path,
    mimeType,
    source: { type: "stored", key: testFileKey(path) },
  });
