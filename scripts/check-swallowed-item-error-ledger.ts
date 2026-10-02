// Existing swallowed-item handler budgets may only lose members.
import { panic } from "better-result";
import path from "node:path";

import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const LEDGER_REL = "scripts/swallowed-item-error-ledger.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

type LedgerEntry = { id: string; reason: string };

const isReasonedEntry = (entry: unknown): entry is LedgerEntry =>
  typeof entry === "object" &&
  entry !== null &&
  "id" in entry &&
  typeof entry.id === "string" &&
  "reason" in entry &&
  typeof entry.reason === "string" &&
  entry.reason.trim().length > 0;

const parseLedger = (text: string, label: string): string[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(isReasonedEntry)) {
    panic(`${label} must be a reasoned ledger`);
  }
  return parsed.map((entry) => entry.id);
};

if (import.meta.main) {
  process.exit(
    runLedgerMembershipGuard({
      ledgerRel: LEDGER_REL,
      repoRoot: REPO_ROOT,
      parseLedger,
      label: "swallowed-item-error",
      remediation: "surface the item failure instead of listing a new handler",
    }),
  );
}
