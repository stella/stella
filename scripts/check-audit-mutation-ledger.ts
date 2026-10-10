// The audit-mutation ledger may only lose members: an owner, or a write
// within an owner, that the base branch does not budget cannot be added in
// place of a removed one, and every row must still name a file in the tree.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  AUDIT_MUTATION_LEDGER_REL,
  auditMutationLedgerMembers,
  parseAuditMutationLedger,
} from "./audit-mutation-ledger-scope.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const parseLedger = (text: string, label: string): string[] =>
  auditMutationLedgerMembers(parseAuditMutationLedger(JSON.parse(text), label));

const missingFiles = (): string[] => {
  const rows = parseAuditMutationLedger(
    JSON.parse(
      readFileSync(path.join(REPO_ROOT, AUDIT_MUTATION_LEDGER_REL), "utf-8"),
    ),
    AUDIT_MUTATION_LEDGER_REL,
  );
  return [
    ...new Set(rows.map((row) => row.id.slice(0, row.id.indexOf("::")))),
  ].filter((file) => !existsSync(path.join(REPO_ROOT, file)));
};

if (import.meta.main) {
  const status = runLedgerMembershipGuard({
    ledgerRel: AUDIT_MUTATION_LEDGER_REL,
    repoRoot: REPO_ROOT,
    parseLedger,
    label: "audit-mutation",
    remediation:
      "record an audit event for the write (or a reasoned `// audit: skip`) instead of budgeting it",
  });
  if (status !== 0 || process.argv.includes("--self-test")) {
    process.exit(status);
  }
  const missing = missingFiles();
  for (const file of missing) {
    console.error(
      `${AUDIT_MUTATION_LEDGER_REL} budgets ${file}, which no longer exists; run bun scripts/audit-mutation-ledger.ts --write`,
    );
  }
  process.exit(missing.length === 0 ? 0 : 1);
}
