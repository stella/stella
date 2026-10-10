import { panic } from "better-result";
import { existsSync } from "node:fs";
import path from "node:path";

import { parseContractDomainLedger } from "./contract-domain-ledger.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const LEDGER_REL = "scripts/contract-domain-ledger.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

if (import.meta.main) {
  process.exit(
    runLedgerMembershipGuard({
      ledgerRel: LEDGER_REL,
      repoRoot: REPO_ROOT,
      parseLedger: (text, label) => {
        const entries = parseContractDomainLedger(text, label);
        if (label === LEDGER_REL) {
          for (const entry of entries) {
            const file = entry.id.split("::").at(0);
            if (file === undefined || !existsSync(path.join(REPO_ROOT, file))) {
              panic(`Remove stale contract domain site ${entry.id}`);
            }
          }
        }
        return entries.map((entry) => entry.id);
      },
      label: "contract-domain",
      remediation:
        "import the contract domain or limit instead of listing a new site",
    }),
  );
}
