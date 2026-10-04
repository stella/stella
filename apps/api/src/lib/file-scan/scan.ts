import { Result, TaggedError } from "better-result";

import { declaredMimeMatchesMagic } from "@/api/lib/file-scan/magic";
import { mapMatchFinding, scanner } from "@/api/lib/file-scan/pipeline";
import type { ScanContext } from "@/api/lib/file-scan/scanner";
import type { ScanFinding, ScanResult } from "@/api/lib/file-scan/types";
import { aggregateVerdict } from "@/api/lib/file-scan/verdict";
import { hasZipMagic, ZIP_BASED_MIMES } from "@/api/lib/file-scan/zip";
import {
  isEncryptedOoxmlContainer,
  isExactEncryptedOoxmlLayout,
} from "@/api/lib/files/encrypted-ooxml";

/** `yara/office-macros.yar`: any CFB container warns. */
const OLE2_CONTAINER_RULE = "ole2_container";

class FileScanError extends TaggedError("FileScanError")<{
  message: string;
  cause?: unknown;
}> {}

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

      // A password-protected Office document is a CFB container around the
      // encrypted zip, not a zip; it is accepted under its declared type and
      // recorded as encrypted, like an encrypted PDF.
      if (
        ZIP_BASED_MIMES.includes(declaredMimeType) &&
        !hasZipMagic(buffer) &&
        !isEncryptedOoxmlContainer(declaredMimeType, buffer)
      ) {
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
      // The compound-file warning is about what the container may hide. A
      // password-protected Office document whose directory is exactly the
      // encrypted layout hides nothing beyond the encrypted package, so it is
      // treated like an encrypted PDF; any other entry keeps the warning.
      const exemptCompoundFileWarning = isExactEncryptedOoxmlLayout(
        declaredMimeType,
        buffer,
      );

      for (const m of matches) {
        if (exemptCompoundFileWarning && m.rule === OLE2_CONTAINER_RULE) {
          continue;
        }
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
