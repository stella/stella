import { panic } from "better-result";
import { expect, test } from "bun:test";
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

test("statement ceiling allowances only shrink after their initial census", () => {
  const current = v.parse(ledgerSchema, ledger);
  const base = Bun.spawnSync(["git", "merge-base", "HEAD", "origin/main"]);
  if (base.exitCode !== 0) {
    panic(
      `Statement ceiling ledger requires origin/main: ${base.stderr.toString()}`,
    );
  }
  const revision = base.stdout.toString().trim();
  const files = Bun.spawnSync([
    "git",
    "ls-tree",
    "--name-only",
    revision,
    "--",
    ledgerPath,
  ]);
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
