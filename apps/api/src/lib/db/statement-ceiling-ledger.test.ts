import { panic } from "better-result";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { DEFAULT_STATEMENT_CEILING } from "./statement-ceiling";
import ledger from "./statement-ceiling.json";

const entries = v.record(
  v.string(),
  v.object({
    threshold: v.pipe(
      v.number(),
      v.integer(),
      v.minValue(DEFAULT_STATEMENT_CEILING + 1),
    ),
    reason: v.pipe(v.string(), v.trim(), v.minLength(1)),
  }),
);
const ledgerSchema = v.object({
  request: entries,
  mcp: entries,
  worker: entries,
  scheduler: entries,
});
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
  const base = Bun.spawnSync(["git", "merge-base", "HEAD", "origin/main"]);
  if (base.exitCode !== 0) {
    panic(
      `Statement ceiling ledger requires origin/main: ${base.stderr.toString()}`,
    );
  }
  const revision = base.stdout.toString().trim();
  const files = ledgerFiles({ revision });
  if (files.exitCode !== 0) {
    panic("Cannot enumerate the statement ceiling ledger base");
  }
  if (files.stdout.toString().trim() === "") {
    // The introducing change owns the measured initial census.
    return;
  }
  const original = Bun.spawnSync(["git", "show", `${revision}:${ledgerPath}`]);
  if (original.exitCode !== 0) {
    panic("Cannot read the statement ceiling ledger base");
  }
  const previous = v.parse(
    ledgerSchema,
    JSON.parse(original.stdout.toString()),
  );
  for (const kind of ["request", "mcp", "worker", "scheduler"] as const) {
    for (const [key, entry] of Object.entries(current[kind])) {
      const before = previous[kind][key];
      expect(before, `New statement allowance: ${kind} ${key}`).toBeDefined();
      expect(
        entry.threshold,
        `Statement allowance widened: ${kind} ${key}`,
      ).toBeLessThanOrEqual(before?.threshold ?? 0);
    }
  }
});
