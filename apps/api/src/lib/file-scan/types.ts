export type ScanVerdict = "pass" | "warn" | "reject";

export type ScanFinding = {
  rule: string;
  severity: ScanVerdict;
  message: string;
};

export type ScanResult = {
  verdict: ScanVerdict;
  findings: ScanFinding[];
};
