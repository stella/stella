// The startup bundle ledger only shrinks.
//
// scripts/bundle-startup-ledger.json lists the page code the startup graph
// still carries and the pages a route still loads late. The web-build gates
// fail on an offender the ledger does not list and on a listed one that no
// longer offends, but they read the ledger of the tree they check: a change
// that adds an offender and its ledger line together would pass them. This
// compares the ledger's exceptions with the merge base and fails on any the
// base did not grant, so a new exception needs the offender fixed instead.
//
//   bun scripts/check-bundle-startup-ledger.ts --base <ref>
//   bun scripts/check-bundle-startup-ledger.ts --self-test

import { panic } from "better-result";
import path from "node:path";
import * as v from "valibot";

import { startupLedgerKeys, StartupLedgerSchema } from "./bundle-startup-gates";
import { runLedgerMembershipGuard } from "./ledger-membership";

const LEDGER_REL = "scripts/bundle-startup-ledger.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The exceptions a ledger text grants, as the gates match them. */
export const parseBundleStartupLedger = (
  text: string,
  label: string,
): string[] => {
  const ledger = v.safeParse(StartupLedgerSchema, JSON.parse(text));
  if (!ledger.success) {
    return panic(
      `${label} is not a startup bundle ledger: ${v.summarize(ledger.issues)}`,
    );
  }
  return startupLedgerKeys(ledger.output);
};

if (import.meta.main) {
  process.exit(
    runLedgerMembershipGuard({
      ledgerRel: LEDGER_REL,
      repoRoot: REPO_ROOT,
      parseLedger: parseBundleStartupLedger,
      label: "bundle-startup",
      remediation:
        "fix the new page code or late page instead of listing it (scripts/bundle-startup-gates.ts)",
    }),
  );
}
