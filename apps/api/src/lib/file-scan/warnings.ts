import type { ScanResult } from "@/api/lib/file-scan/types";

/**
 * Warning strings to persist after a successful scan (verdict is not `reject`).
 * Returns `null` when there is nothing to store.
 */
export const getScanWarnings = (scanResult: ScanResult): string[] | null => {
  if (scanResult.verdict !== "warn") {
    return null;
  }

  return scanResult.findings.flatMap((finding) =>
    finding.severity === "warn" ? [finding.message] : [],
  );
};
