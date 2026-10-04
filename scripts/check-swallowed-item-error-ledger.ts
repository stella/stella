// Existing swallowed-item handler budgets may only lose members.
import path from "node:path";

import {
  parseReasonedLedger,
  runLedgerMembershipGuard,
} from "./ledger-membership.ts";

const LEDGER_REL = "scripts/swallowed-item-error-ledger.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

if (import.meta.main) {
  process.exit(
    runLedgerMembershipGuard({
      ledgerRel: LEDGER_REL,
      repoRoot: REPO_ROOT,
      parseLedger: parseReasonedLedger,
      label: "swallowed-item-error",
      remediation: "surface the item failure instead of listing a new handler",
    }),
  );
}
