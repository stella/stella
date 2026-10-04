import { describe, expect, test } from "bun:test";

import ledger from "../.oxlint-plugins/require-audit-on-mutation-ledger.json" with { type: "json" };
import {
  auditMutationBudgets,
  auditMutationLedgerMembers,
  parseAuditMutationLedger,
} from "./audit-mutation-ledger-scope.ts";
import { nextAuditMutationLedger } from "./audit-mutation-ledger.ts";

const row = (id: string, writes: number, reason = "Reviewed reason.") => ({
  id,
  writes,
  reason,
});

describe("audit mutation ledger", () => {
  test("the committed ledger is well formed", () => {
    const rows = parseAuditMutationLedger(ledger, "committed ledger");
    expect(rows.length).toBeGreaterThan(0);
    expect(Object.keys(auditMutationBudgets(ledger))).toHaveLength(rows.length);
  });

  test("lowering a count keeps the reason and drops fixed owners", () => {
    const { rows, refused } = nextAuditMutationLedger({
      current: new Map([["a.ts::save", 1]]),
      previous: [row("a.ts::save", 2, "Kept."), row("b.ts::clear", 1)],
      seed: false,
    });
    expect(refused).toEqual([]);
    expect(rows).toEqual([row("a.ts::save", 1, "Kept.")]);
  });

  test("a new owner or a raised count is refused outside seeding", () => {
    const { refused } = nextAuditMutationLedger({
      current: new Map([
        ["a.ts::save", 3],
        ["c.ts::fresh", 1],
      ]),
      previous: [row("a.ts::save", 2)],
      seed: false,
    });
    expect(refused).toEqual(["a.ts::save: 2 -> 3", "c.ts::fresh: 0 -> 1"]);
  });

  test("seeding records every owner with a path-derived reason", () => {
    const { rows } = nextAuditMutationLedger({
      current: new Map([["apps/api/src/lib/scheduler/x.ts::run", 1]]),
      previous: [],
      seed: true,
    });
    expect(rows.at(0)?.reason).toContain("Scheduled system job");
  });

  test("members expand per write so a raised count is an added member", () => {
    expect(auditMutationLedgerMembers([row("a.ts::save", 2)])).toEqual([
      "a.ts::save#1",
      "a.ts::save#2",
    ]);
  });

  test("malformed rows are rejected", () => {
    expect(() => parseAuditMutationLedger([row("a.ts::x", 0)], "x")).toThrow(
      "must be a list of reasoned",
    );
    expect(() =>
      parseAuditMutationLedger([row("a.ts::x", 1, " ")], "x"),
    ).toThrow("must be a list of reasoned");
    expect(() =>
      parseAuditMutationLedger([row("a.ts::x", 1), row("a.ts::x", 1)], "x"),
    ).toThrow("lists an owner twice");
  });
});
