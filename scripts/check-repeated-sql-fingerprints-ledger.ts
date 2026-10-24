import { panic } from "better-result";
import path from "node:path";

import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const LEDGER_REL =
  "apps/api/src/lib/observability/repeated-sql-fingerprints.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");
export const parseRepeatedSqlFingerprintLedger = (
  text: string,
  label: string,
): string[] => {
  const parsed: unknown = JSON.parse(text);
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "id" in entry &&
        typeof entry.id === "string" &&
        "count" in entry &&
        typeof entry.count === "number" &&
        Number.isInteger(entry.count) &&
        entry.count > 1 &&
        "reason" in entry &&
        typeof entry.reason === "string" &&
        entry.reason.trim().length > 0,
    )
  ) {
    return panic(
      `${label} must contain reasoned fingerprints and repeat counts`,
    );
  }
  return parsed.flatMap((entry) =>
    Array.from(
      { length: entry.count },
      (_, index) => `${String(entry.id)}::${index + 1}`,
    ),
  );
};

if (import.meta.main) {
  process.exit(
    runLedgerMembershipGuard({
      ledgerRel: LEDGER_REL,
      repoRoot: REPO_ROOT,
      parseLedger: parseRepeatedSqlFingerprintLedger,
      label: "repeated-sql-fingerprints",
      remediation:
        "remove the repeated query or prove the repeated callsite is required with a reasoned count",
    }),
  );
}
