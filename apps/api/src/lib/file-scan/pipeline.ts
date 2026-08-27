import { createArchiveContentScanner } from "@/api/lib/file-scan/archive";
import {
  composeScanners,
  createZipBombGuard,
} from "@/api/lib/file-scan/scanner";
import type { Match } from "@/api/lib/file-scan/scanner";
import type { ScanFinding, ScanVerdict } from "@/api/lib/file-scan/types";
import { yaraScanner } from "@/api/lib/file-scan/yara";

const MAX_ZIP_ENTRIES = 1000;

const zipBombGuard = createZipBombGuard({
  maxEntries: MAX_ZIP_ENTRIES,
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  maxCompressionRatio: 1000,
});

// Inflated bytes are held in memory for rule evaluation, so this budget is
// far below the size at which the guard above rejects an archive outright.
const archiveContentScanner = createArchiveContentScanner(yaraScanner, {
  maxEntries: MAX_ZIP_ENTRIES,
  maxEntryBytes: 32 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
});

export const scanner = composeScanners(
  zipBombGuard,
  yaraScanner,
  archiveContentScanner,
);

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
