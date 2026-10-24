import { panic } from "better-result";
import { existsSync } from "node:fs";
import path from "node:path";

import { parseContractDomainLedger } from "./contract-domain-ledger.ts";
import { ledgerGitEnv, runLedgerMembershipGuard } from "./ledger-membership.ts";

const LEDGER_REL = "scripts/contract-domain-ledger.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

type RelocateContractDomainEntriesOptions = {
  entries: readonly string[];
  baseCommit: string;
  repoRoot: string;
};

export const relocateContractDomainEntries = ({
  entries,
  baseCommit,
  repoRoot,
}: RelocateContractDomainEntriesOptions): string[] => {
  const diff = Bun.spawnSync(
    [
      "git",
      "diff",
      "--name-status",
      "-z",
      "--find-renames",
      "--diff-filter=R",
      baseCommit,
      "--",
    ],
    { cwd: repoRoot, env: ledgerGitEnv(), stderr: "pipe" },
  );
  if (diff.exitCode !== 0) {
    return panic(
      `Cannot read contract domain renames: ${diff.stderr.toString()}`,
    );
  }
  const fields = diff.stdout.toString().split("\0");
  const renames = new Map<string, string>();
  for (let index = 0; index < fields.length - 1; index += 3) {
    const status = fields.at(index);
    const from = fields.at(index + 1);
    const to = fields.at(index + 2);
    if (status === undefined || !/^R\d+$/u.test(status) || !from || !to) {
      return panic("Malformed contract domain rename record");
    }
    renames.set(from, to);
  }
  // Preserve the owner, constraint and occurrence; a move cannot add a site.
  return entries.map((entry) => {
    const separator = entry.indexOf("::");
    const renamed = renames.get(entry.slice(0, separator));
    return renamed === undefined
      ? entry
      : `${renamed}${entry.slice(separator)}`;
  });
};

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
      normalizeBaseEntries: (entries, baseCommit) =>
        relocateContractDomainEntries({
          entries,
          baseCommit,
          repoRoot: REPO_ROOT,
        }),
      label: "contract-domain",
      remediation:
        "import the contract domain or limit instead of listing a new site",
    }),
  );
}
