import {
  composeScanners,
  createZipBombGuard,
} from "@/api/lib/file-scan/scanner";
import type { Match } from "@/api/lib/file-scan/scanner";
import type { ScanFinding, ScanVerdict } from "@/api/lib/file-scan/types";
import { yaraScanner } from "@/api/lib/file-scan/yara";

const zipBombGuard = createZipBombGuard({
  maxEntries: 1000,
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  maxCompressionRatio: 1000,
});

export const scanner = composeScanners(zipBombGuard, yaraScanner);

const MATCH_SEVERITY_TO_VERDICT: Record<
  NonNullable<Match["severity"]>,
  ScanVerdict
> = {
  info: "pass",
  low: "pass",
  medium: "warn",
  high: "warn",
  critical: "reject",
  suspicious: "warn",
  malicious: "reject",
};

export const mapMatchFinding = (m: Match): ScanFinding => ({
  rule: m.rule,
  severity: m.severity ? MATCH_SEVERITY_TO_VERDICT[m.severity] : "warn",
  message:
    typeof m.meta?.["description"] === "string"
      ? m.meta["description"]
      : m.rule,
});
