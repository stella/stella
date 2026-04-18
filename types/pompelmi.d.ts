/**
 * Missing type declarations for pompelmi.
 * The package ships no .d.ts files; these are the types
 * used by our file-scan integration.
 */
declare module "pompelmi" {
  type Severity =
    | "info"
    | "low"
    | "medium"
    | "high"
    | "critical"
    | "suspicious"
    | "malicious";

  type Match = {
    rule: string;
    severity?: Severity;
    meta?: Record<string, unknown>;
  };

  type Scanner = {
    scan(bytes: Uint8Array): Promise<Match[]>;
  };

  type ScanContext = {
    filename: string;
    mimeType: string;
  };

  type ComposedScanner = (
    buffer: Uint8Array,
    ctx: ScanContext,
  ) => Promise<Match[]>;

  const CommonHeuristicsScanner: Scanner;

  function composeScanners(...scanners: Scanner[]): ComposedScanner;

  function createZipBombGuard(opts: {
    maxEntries: number;
    maxTotalUncompressedBytes: number;
    maxCompressionRatio: number;
  }): Scanner;
}
