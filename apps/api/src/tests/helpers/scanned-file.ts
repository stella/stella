import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { mintScannedFile } from "@/api/lib/file-scan/scanned-file";
import type { ScanResult } from "@/api/lib/file-scan/types";
import { getScanWarnings } from "@/api/lib/file-scan/warnings";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import { testFileKey } from "@/api/tests/helpers/file-key";

/**
 * Fixture bytes as a `ScannedFile`, for tests of parser callers. With `scan`
 * the file carries that (non-rejecting) scan result, as `scanUpload` would
 * return it; without, it stands for a stored file.
 */
export const testScannedFile = ({
  bytes,
  mimeType,
  path = "org/ws/fixture",
  scan,
}: {
  bytes: ArrayBuffer;
  mimeType: string;
  path?: string;
  scan?: ScanResult;
}): ScannedFile =>
  mintScannedFile({
    bytes,
    fileName: path,
    mimeType,
    source:
      scan === undefined
        ? { type: "stored", key: testFileKey(path) }
        : { type: "scan", scan, warnings: getScanWarnings(scan) },
  });

/**
 * DOCX fixture bytes as a stored `ScannedFile`, for the template and style-set
 * parsers. The bytes are copied, so a fixture buffer can be reused.
 */
export const testDocxFile = (
  bytes: ArrayBuffer | Uint8Array,
  path = "org/templates/fixture.docx",
): ScannedFile =>
  testScannedFile({
    bytes: new Uint8Array(bytes).slice().buffer,
    mimeType: DOCX_MIME_TYPE,
    path,
  });
