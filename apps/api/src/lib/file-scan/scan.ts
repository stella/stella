import { Result, TaggedError } from "better-result";
import type { ScanContext } from "pompelmi";

import { mapMatchFinding, scanner } from "@/api/lib/file-scan/pompelmi";
import type { ScanFinding, ScanResult } from "@/api/lib/file-scan/types";
import { aggregateVerdict } from "@/api/lib/file-scan/verdict";
import { hasZipMagic, ZIP_BASED_MIMES } from "@/api/lib/file-scan/zip";

export type {
  ScanFinding,
  ScanResult,
  ScanVerdict,
} from "@/api/lib/file-scan/types";

export class FileScanError extends TaggedError("FileScanError")<{
  message: string;
  cause?: unknown;
}>() {}

type ScanFileInput = {
  buffer: Uint8Array;
  declaredMimeType: string;
  fileName: string;
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
