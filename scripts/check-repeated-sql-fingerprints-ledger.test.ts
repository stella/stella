import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parseRepeatedSqlFingerprintLedger } from "./check-repeated-sql-fingerprints-ledger.ts";
import {
  addedEntries,
  ledgerMergeBase,
  runLedgerMembershipGuard,
} from "./ledger-membership.ts";

const ledgerPath =
  "apps/api/src/lib/observability/repeated-sql-fingerprints.json";
const repoRoot = path.resolve(import.meta.dir, "..");

test("repeated SQL callsite ledger starts empty and can only shrink", () => {
  const ledger = parseRepeatedSqlFingerprintLedger(
    readFileSync(ledgerPath, "utf-8"),
    ledgerPath,
  );
  expect(ledger).toEqual([]);
  expect(addedEntries(["new-callsite"], ledger)).toEqual(["new-callsite"]);
  expect(addedEntries([], ["old-callsite"])).toEqual([]);
  const members = (count: number) =>
    parseRepeatedSqlFingerprintLedger(
      JSON.stringify([
        { id: "callsite", count, reason: "Required bounded read sequence" },
      ]),
      "fixture",
    );
  expect(addedEntries(members(2), members(3))).toEqual([]);
  expect(addedEntries(members(3), members(2))).toEqual(["callsite::3"]);

  const base = ledgerMergeBase({ repoRoot, baseRef: "origin/main" });
  expect(
    runLedgerMembershipGuard({
      ledgerRel: ledgerPath,
      repoRoot,
      parseLedger: parseRepeatedSqlFingerprintLedger,
      label: "repeated-sql-fingerprints",
      remediation: "remove repeats or reduce recorded repeat counts",
      args: ["--base", base],
      log: () => undefined,
      error: () => undefined,
    }),
  ).toBe(0);
});
