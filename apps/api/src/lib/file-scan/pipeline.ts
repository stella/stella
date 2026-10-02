import { createArchiveContentScanner } from "@/api/lib/file-scan/archive";
import { attachedTemplateScanner } from "@/api/lib/file-scan/attached-template";
import {
  composeScanners,
  createZipBombGuard,
} from "@/api/lib/file-scan/scanner";
import type { Match } from "@/api/lib/file-scan/scanner";
import type { ScanFinding, ScanVerdict } from "@/api/lib/file-scan/types";
import { yaraScanner, yaraWindowedRules } from "@/api/lib/file-scan/yara";

const MAX_ZIP_ENTRIES = 1000;

const zipBombGuard = createZipBombGuard({
  maxEntries: MAX_ZIP_ENTRIES,
  maxTotalUncompressedBytes: 500 * 1024 * 1024,
  maxCompressionRatio: 1000,
});

// The guard above bounds how much an archive may inflate to; this budget
// bounds what inspecting it may hold and take. The time budget stays well
// inside the upload finalize claim (FINALIZE_CLAIM_TIMEOUT_MS).
const archiveContentScanner = createArchiveContentScanner({
  rules: yaraWindowedRules,
  budget: {
    windowBytes: 1024 * 1024,
    maxEvidenceBytes: 8 * 1024 * 1024,
    timeBudgetMs: 30_000,
  },
  guard: zipBombGuard,
});

export const scanner = composeScanners(
  zipBombGuard,
  attachedTemplateScanner,
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
