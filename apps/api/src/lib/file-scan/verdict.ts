import type { ScanFinding, ScanVerdict } from "@/api/lib/file-scan/types";

const VERDICT_PRIORITY = {
  pass: 0,
  warn: 1,
  reject: 2,
} as const satisfies Record<ScanVerdict, number>;

export const aggregateVerdict = (
  findings: readonly ScanFinding[],
): ScanVerdict => {
  let highest: ScanVerdict = "pass";

  for (const f of findings) {
    if (VERDICT_PRIORITY[f.severity] > VERDICT_PRIORITY[highest]) {
      highest = f.severity;
    }
  }

  return highest;
};
