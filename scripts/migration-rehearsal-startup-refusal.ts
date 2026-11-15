#!/usr/bin/env bun
// Names the startup check that kept the served release from booting against
// the database this checkout's upgrade produced, for
// scripts/rehearse-migration-upgrade.sh.
//
//   bun scripts/migration-rehearsal-startup-refusal.ts <log> <ledger-before> <ledger-after>
//
// <log> is the served release's container log; the ledgers list the applied
// migration names, one per line, before and after this checkout's upgrade.
// Prints one line: which check refused, its refusal, and the migrations this
// checkout applied over the served release's schema.

import { readFileSync } from "node:fs";

type RefusalRule = { check: string; pattern: RegExp };

// Ordered: the first rule whose pattern occurs in the log names the check.
const RULES: readonly RefusalRule[] = [
  {
    check:
      "online migration validation, which refuses a pending online step introduced by a migration older than the newest applied one",
    pattern:
      /Online (?:index|cutover|replacement_drop|repair) \S+ introduced by \S+ is not complete: [^\n]*/u,
  },
  {
    check:
      "online migration validation, which refuses a pending code-owned online step",
    pattern:
      /Online (?:index|cutover|replacement_drop|repair) \S+ owned by \S+ is not complete: [^\n]*/u,
  },
  {
    check: "online index validation",
    pattern:
      /Required migration index \S+ (?:is missing|is not ready|has reindex artifacts)/u,
  },
  {
    check: "the Better Auth OAuth policy census",
    pattern:
      /Better Auth OAuth policy (?:migration is incomplete|census returned an invalid result)/u,
  },
  {
    check: "the migration history check",
    pattern: /\[startup\] (?:Schema drift|No migration files)[^\n]*/u,
  },
];

// Bun's report of an uncaught startup error: `error: …`, `Panic: …`, `XError: …`.
const UNCAUGHT_LINE = /^ *(?:error|panic|[A-Za-z]*Error): \S/iu;
const FAILED_CHECKS = /failedChecks:\s*\[([^\]]*)\]/u;

const ledgerNames = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

const describeRefusal = (log: string): string => {
  for (const { check, pattern } of RULES) {
    const match = pattern.exec(log);
    if (match !== null) {
      const failedChecks = FAILED_CHECKS.exec(log)?.[1]?.replace(/\s+/gu, " ");
      const detail =
        failedChecks === undefined
          ? ""
          : ` (failed checks: ${failedChecks.trim()})`;
      return `${check} refused with "${match[0].trim()}"${detail}`;
    }
  }
  const uncaught = log.split("\n").findLast((line) => UNCAUGHT_LINE.test(line));
  if (uncaught !== undefined) {
    return `an unclassified startup step refused with "${uncaught.trim()}"`;
  }
  return "it exited or missed readiness without a refusal in its log";
};

export const explainStartupRefusal = ({
  log,
  ledgerBefore,
  ledgerAfter,
}: {
  log: string;
  ledgerBefore: string;
  ledgerAfter: string;
}): string => {
  const before = new Set(ledgerNames(ledgerBefore));
  const applied = ledgerNames(ledgerAfter)
    .filter((name) => !before.has(name))
    .toSorted();
  const migrations =
    applied.length === 0
      ? "this checkout applied no migrations over it"
      : `migrations this checkout applied over it: ${applied.join(", ")} (newest ${applied.at(-1) ?? ""})`;
  return `${describeRefusal(log)}; ${migrations}`;
};

if (import.meta.main) {
  const [logPath, beforePath, afterPath] = process.argv.slice(2);
  if (
    logPath === undefined ||
    beforePath === undefined ||
    afterPath === undefined
  ) {
    console.error(
      "Usage: bun scripts/migration-rehearsal-startup-refusal.ts <log> <ledger-before> <ledger-after>",
    );
    process.exit(2);
  }
  console.log(
    explainStartupRefusal({
      log: readFileSync(logPath, "utf-8"),
      ledgerBefore: readFileSync(beforePath, "utf-8"),
      ledgerAfter: readFileSync(afterPath, "utf-8"),
    }),
  );
}
