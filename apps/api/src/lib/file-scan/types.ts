export type ScanVerdict = "pass" | "warn" | "reject";

export type ScanFinding = {
  rule: string;
  severity: ScanVerdict;
  message: string;
  /** See `Match.failure`. */
  failure?: unknown;
};

export type ScanResult = {
  verdict: ScanVerdict;
  findings: ScanFinding[];
};
