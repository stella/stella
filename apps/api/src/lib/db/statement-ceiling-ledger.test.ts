import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { treeBaseRevision } from "@stll/scripts/src/tree-base-revision";

import { DEFAULT_STATEMENT_CEILING } from "./statement-ceiling";
import approvedRaises from "./statement-ceiling-approved-raises.json";
import ledger from "./statement-ceiling.json";

const kinds = ["request", "mcp", "worker", "scheduler"] as const;
const threshold = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(DEFAULT_STATEMENT_CEILING + 1),
);
const reason = v.pipe(v.string(), v.trim(), v.minLength(1));
const entries = v.record(v.string(), v.object({ threshold, reason }));
const ledgerSchema = v.object({
  request: entries,
  mcp: entries,
  worker: entries,
  scheduler: entries,
});
type Ledger = v.InferOutput<typeof ledgerSchema>;

/**
 * Allowances only shrink; an approved raise of one allowance is recorded in
 * statement-ceiling-approved-raises.json, and the record is removed once the
 * allowance no longer stands at its `to`.
 */
const approvedRaisesSchema = v.pipe(
  v.array(
    v.pipe(
      v.strictObject({
        kind: v.picklist(kinds),
        key: v.pipe(v.string(), v.minLength(1)),
        from: threshold,
        to: threshold,
        date: v.pipe(v.string(), v.isoDate()),
        reason,
      }),
      v.check(
        ({ from, to }) => to > from,
        "An approved raise must increase the allowance",
      ),
    ),
  ),
  v.check(
    (raises) =>
      new Set(raises.map(({ kind, key }) => `${kind} ${key}`)).size ===
      raises.length,
    "Record at most one approved raise per allowance",
  ),
);
type ApprovedRaises = v.InferOutput<typeof approvedRaisesSchema>;

type AllowanceViolationsOptions = {
  /** The merge-base ledger; undefined while the ledger is first introduced. */
  previous: Ledger | undefined;
  current: Ledger;
  raises: ApprovedRaises;
};

const allowanceViolations = ({
  previous,
  current,
  raises,
}: AllowanceViolationsOptions) => {
  const violations: string[] = [];
  for (const kind of kinds) {
    for (const [key, entry] of Object.entries(current[kind])) {
      if (previous === undefined) {
        continue;
      }
      const before = previous[kind][key];
      if (before === undefined) {
        violations.push(`New statement allowance: ${kind} ${key}`);
        continue;
      }
      if (entry.threshold <= before.threshold) {
        continue;
      }
      const approved = raises.some(
        (raise) =>
          raise.kind === kind &&
          raise.key === key &&
          raise.from === before.threshold &&
          raise.to === entry.threshold,
      );
      if (!approved) {
        violations.push(
          `Statement allowance widened without an approved raise: ${kind} ${key} ${before.threshold} -> ${entry.threshold}`,
        );
      }
    }
  }
  for (const raise of raises) {
    if (current[raise.kind][raise.key]?.threshold !== raise.to) {
      violations.push(
        `Stale approved raise: ${raise.kind} ${raise.key} no longer stands at ${raise.to}`,
      );
    }
  }
  return violations;
};
const ledgerPath = "apps/api/src/lib/db/statement-ceiling.json";

type LedgerFilesOptions = { revision: string; cwd?: string };

const ledgerFiles = ({ revision, cwd = process.cwd() }: LedgerFilesOptions) =>
  Bun.spawnSync(
    [
      "git",
      "ls-tree",
      "--full-tree",
      "--name-only",
      revision,
      "--",
      ledgerPath,
    ],
    { cwd },
  );

test("finds the statement ceiling ledger from the API package directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "statement-ceiling-ledger-"));
  try {
    const apiDirectory = path.join(root, "apps/api");
    mkdirSync(path.dirname(path.join(root, ledgerPath)), { recursive: true });
    writeFileSync(path.join(root, ledgerPath), JSON.stringify(ledger));
    for (const command of [
      ["git", "init", "--quiet"],
      ["git", "add", "--", ledgerPath],
    ]) {
      const result = Bun.spawnSync(command, { cwd: root });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    const tree = Bun.spawnSync(["git", "write-tree"], { cwd: root });
    expect(tree.exitCode, tree.stderr.toString()).toBe(0);
    const files = ledgerFiles({
      revision: tree.stdout.toString().trim(),
      cwd: apiDirectory,
    });
    expect(files.exitCode, files.stderr.toString()).toBe(0);
    expect(files.stdout.toString().trim()).toBe(ledgerPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("statement ceiling allowances only shrink after their initial census", () => {
  const current = v.parse(ledgerSchema, ledger);
  const raises = v.parse(approvedRaisesSchema, approvedRaises);
  const revision = treeBaseRevision({ repoRoot: process.cwd() });
  const files = ledgerFiles({ revision });
  if (files.exitCode !== 0) {
    panic("Cannot enumerate the statement ceiling ledger base");
  }
  // The introducing change owns the measured initial census.
  let previous: Ledger | undefined;
  if (files.stdout.toString().trim() !== "") {
    const original = Bun.spawnSync([
      "git",
      "show",
      `${revision}:${ledgerPath}`,
    ]);
    if (original.exitCode !== 0) {
      panic("Cannot read the statement ceiling ledger base");
    }
    previous = v.parse(ledgerSchema, JSON.parse(original.stdout.toString()));
  }
  expect(allowanceViolations({ previous, current, raises })).toEqual([]);
});

describe("statement ceiling approved raises", () => {
  const ledgerAt = (value: number): Ledger => ({
    request: {},
    mcp: {},
    worker: {},
    scheduler: { "reset.task": { threshold: value, reason: "Measured." } },
  });
  const raise = (from: number, to: number) => ({
    kind: "scheduler" as const,
    key: "reset.task",
    from,
    to,
    date: "2026-11-20",
    reason: "Approved after a measured census.",
  });

  test("rejects an unrecorded increase", () => {
    expect(
      allowanceViolations({
        previous: ledgerAt(200),
        current: ledgerAt(250),
        raises: [],
      }),
    ).toEqual([
      "Statement allowance widened without an approved raise: scheduler reset.task 200 -> 250",
    ]);
  });

  test("accepts an increase that matches its record", () => {
    expect(
      allowanceViolations({
        previous: ledgerAt(200),
        current: ledgerAt(250),
        raises: [raise(200, 250)],
      }),
    ).toEqual([]);
  });

  test("keeps a record while the allowance stands at its raised value", () => {
    expect(
      allowanceViolations({
        previous: ledgerAt(250),
        current: ledgerAt(250),
        raises: [raise(200, 250)],
      }),
    ).toEqual([]);
  });

  test("rejects a record whose from differs from the base allowance", () => {
    expect(
      allowanceViolations({
        previous: ledgerAt(200),
        current: ledgerAt(250),
        raises: [raise(210, 250)],
      }),
    ).toEqual([
      "Statement allowance widened without an approved raise: scheduler reset.task 200 -> 250",
    ]);
  });

  test("rejects a record whose to differs from the new allowance", () => {
    expect(
      allowanceViolations({
        previous: ledgerAt(200),
        current: ledgerAt(250),
        raises: [raise(200, 300)],
      }),
    ).toEqual([
      "Statement allowance widened without an approved raise: scheduler reset.task 200 -> 250",
      "Stale approved raise: scheduler reset.task no longer stands at 300",
    ]);
  });

  test("rejects a stale record once the allowance shrinks", () => {
    expect(
      allowanceViolations({
        previous: ledgerAt(250),
        current: ledgerAt(220),
        raises: [raise(200, 250)],
      }),
    ).toEqual([
      "Stale approved raise: scheduler reset.task no longer stands at 250",
    ]);
  });

  test("rejects a stale record for an allowance that no longer exists", () => {
    expect(
      allowanceViolations({
        previous: ledgerAt(250),
        current: { request: {}, mcp: {}, worker: {}, scheduler: {} },
        raises: [raise(200, 250)],
      }),
    ).toEqual([
      "Stale approved raise: scheduler reset.task no longer stands at 250",
    ]);
  });

  test("accepts a decrease without a record", () => {
    expect(
      allowanceViolations({
        previous: ledgerAt(250),
        current: ledgerAt(220),
        raises: [],
      }),
    ).toEqual([]);
  });

  test("still rejects a new allowance", () => {
    expect(
      allowanceViolations({
        previous: { request: {}, mcp: {}, worker: {}, scheduler: {} },
        current: ledgerAt(250),
        raises: [],
      }),
    ).toEqual(["New statement allowance: scheduler reset.task"]);
  });

  test("validates the record schema", () => {
    const parse = (input: unknown) =>
      v.safeParse(approvedRaisesSchema, input).success;
    expect(parse([raise(200, 250)])).toBe(true);
    expect(parse([raise(250, 200)])).toBe(false);
    expect(parse([{ ...raise(200, 250), date: "20 Nov 2026" }])).toBe(false);
    expect(parse([{ ...raise(200, 250), reason: " " }])).toBe(false);
    expect(parse([{ ...raise(200, 250), kind: "cron" }])).toBe(false);
    expect(parse([{ ...raise(200, 250), approvedBy: "x" }])).toBe(false);
    expect(parse([raise(200, 250), raise(250, 300)])).toBe(false);
  });
});
