// Write tools whose declared permissions are weaker than one exact grant may
// only lose members: a new one cannot be listed in place of a removed one.
// apps/api/src/mcp/write-tool-authority.test.ts keeps the ledger equal to the
// registry; this keeps it from growing.
import { panic } from "better-result";
import path from "node:path";

import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const LEDGER_REL = "apps/api/src/mcp/write-tool-authority-ledger.json";
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
      label: "write-tool-authority",
      remediation:
        "declare the exact permissions the tool needs (type all) instead of listing it",
    }),
  );
}
