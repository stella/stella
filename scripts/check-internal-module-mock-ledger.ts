// Membership guard for scripts/internal-module-mock-ledger.json.
//
// The ratchet metric caps the ledger's LENGTH, and the oxlint rule reports a
// listed pair whose mock is gone. Neither stops a swap: delete one
// grandfathered "<file>::<specifier>" line and add a different one, and both
// stay green. This check closes that: every line in the working-tree ledger
// must already exist in the base branch's ledger, so the set can only lose
// members. A base that has no ledger yet (the change that introduces it)
// passes trivially.
//
// Modes:
//   bun scripts/check-internal-module-mock-ledger.ts --base origin/main
//   bun scripts/check-internal-module-mock-ledger.ts --self-test

import { panic } from "better-result";
import path from "node:path";

import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const LEDGER_REL = "scripts/internal-module-mock-ledger.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

const parseLedger = (text: string, label: string): string[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((e) => typeof e === "string")) {
    panic(`${label} must be a JSON array of strings`);
  }
  return parsed;
};

if (import.meta.main) {
  process.exit(
    runLedgerMembershipGuard({
      ledgerRel: LEDGER_REL,
      repoRoot: REPO_ROOT,
      parseLedger,
      label: "internal-module-mock",
      remediation: "inject the dependency instead of listing a new mock",
    }),
  );
}
