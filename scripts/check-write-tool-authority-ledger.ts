// Write tools whose declared permissions are weaker than one exact grant may
// only lose members: a new one cannot be listed in place of a removed one.
// apps/api/src/mcp/write-tool-authority.test.ts keeps the ledger equal to the
// registry; this keeps it from growing.
import path from "node:path";

import {
  parseReasonedLedger,
  runLedgerMembershipGuard,
} from "./ledger-membership.ts";

const LEDGER_REL = "apps/api/src/mcp/write-tool-authority-ledger.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

if (import.meta.main) {
  process.exit(
    runLedgerMembershipGuard({
      ledgerRel: LEDGER_REL,
      repoRoot: REPO_ROOT,
      parseLedger: parseReasonedLedger,
      label: "write-tool-authority",
      remediation:
        "declare the exact permissions the tool needs (type all, or type input when the input selects the operation) instead of listing it",
    }),
  );
}
