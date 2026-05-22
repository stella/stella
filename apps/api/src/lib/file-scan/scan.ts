import { Result, TaggedError } from "better-result";

import { declaredMimeMatchesMagic } from "@/api/lib/file-scan/magic";
import { mapMatchFinding, scanner } from "@/api/lib/file-scan/pipeline";
import type { ScanContext } from "@/api/lib/file-scan/scanner";
import type { ScanFinding, ScanResult } from "@/api/lib/file-scan/types";
import { aggregateVerdict } from "@/api/lib/file-scan/verdict";
import { hasZipMagic, ZIP_BASED_MIMES } from "@/api/lib/file-scan/zip";

class FileScanError extends TaggedError("FileScanError")<{
  message: string;
  cause?: unknown;
}>() {}

type ScanFileInput = {
  buffer: Uint8Array;
  declaredMimeType: string;
  fileName: string;
};

/**
 * Warning strings to persist after a successful scan (verdict is not `reject`).
 * Returns `null` when there is nothing to store.
 */
export const getScanWarnings = (scanResult: ScanResult): string[] | null => {
  if (scanResult.verdict !== "warn") {
    return null;
  }

  return scanResult.findings
    .filter((finding) => finding.severity === "warn")
    .map((finding) => finding.message);
};

export const scanFile = async ({
  buffer,
  declaredMimeType,
  fileName,
}: ScanFileInput): Promise<Result<ScanResult, FileScanError>> =>
  await Result.tryPromise({
    try: async () => {
      const findings: ScanFinding[] = [];

      if (ZIP_BASED_MIMES.includes(declaredMimeType) && !hasZipMagic(buffer)) {
        findings.push({
          rule: "corrupt-zip",
          severity: "reject",
          message:
            `File declared as ${declaredMimeType} ` +
            "but does not have valid ZIP structure",
        });
        return {
          verdict: "reject" as const,
          findings,
        };
      }

      // Non-ZIP binary types: flag when the client-declared media type
      // contradicts the file's magic bytes. Text types and any type
      // without a known signature pass through unchecked. The scan
      // still continues — a spoofed or polyglot file must also be
      // inspected by the content scanner below.
      if (!declaredMimeMatchesMagic(declaredMimeType, buffer)) {
        findings.push({
          rule: "mime-magic-mismatch",
          severity: "reject",
          message:
            `File declared as ${declaredMimeType} ` +
            "but its content does not match that type",
        });
      }

      const ctx: ScanContext = {
        filename: fileName,
        mimeType: declaredMimeType,
      };
      const matches = await scanner(buffer, ctx);

      for (const m of matches) {
        findings.push(mapMatchFinding(m));
      }

      return {
        verdict: aggregateVerdict(findings),
        findings,
      };
    },
    catch: (cause) =>
      new FileScanError({
        message: "File security scan failed unexpectedly",
        cause,
      }),
  });
