// Budget ledger of the `calendar-day` lint rules.
//
// scripts/calendar-day-ledger.json lists the sites that still read the UTC
// day as a user-facing day, or the wall clock in a scheduler task, keyed by
// `rule::file::enclosing function::spelling` with a count and a reason (no
// line numbers, so unrelated edits do not move a key). The lint rules enforce
// the counts in both directions; this script keeps the ledger honest:
//
//   bun scripts/calendar-day-ledger.ts --write        regenerate from the code
//   bun scripts/calendar-day-ledger.ts --base <ref>   CI: the ledger only shrinks
//   bun scripts/calendar-day-ledger.ts --self-test    the membership check works
//
// Regeneration keeps each surviving row's reason; a new row gets a TODO reason
// that the CI check rejects, so a new budget is a reviewed, reasoned edit and
// never appears on the base branch's terms.

import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import oxlintConfig from "../oxlint.config.ts";
import { runLedgerMembershipGuard } from "./ledger-membership.ts";

const LEDGER_REL = "scripts/calendar-day-ledger.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PLUGIN = "calendar-day";
const TODO_REASON = "TODO: say why this site keeps its clock";
const CENSUS_TARGETS = ["apps", ".oxlint-plugins/__fixtures__"];

const LedgerRowSchema = v.object({
  id: v.string(),
  count: v.pipe(v.number(), v.integer(), v.minValue(1)),
  reason: v.pipe(v.string(), v.trim(), v.minLength(12)),
});
type LedgerRow = v.InferOutput<typeof LedgerRowSchema>;
const Ledger = v.array(LedgerRowSchema);

const LintOutput = v.object({
  diagnostics: v.array(
    v.object({ code: v.string(), filename: v.string(), message: v.string() }),
  ),
});

/** One membership per budgeted hit, so raising a count is an added member. */
export const expandLedger = (rows: readonly LedgerRow[]): string[] =>
  rows.flatMap((row) =>
    Array.from({ length: row.count }, (_, index) => `${row.id}#${index + 1}`),
  );

const parseLedger = (text: string, label: string): string[] => {
  const rows = v.parse(Ledger, JSON.parse(text));
  const unreasoned = rows.filter((row) => row.reason.startsWith("TODO"));
  if (unreasoned.length > 0) {
    panic(
      `${label}: give each new budget a reason: ${unreasoned.map((row) => row.id).join(", ")}`,
    );
  }
  return expandLedger(rows);
};

const isCalendarDayOverride = (override: unknown): boolean => {
  if (typeof override !== "object" || override === null) {
    return false;
  }
  const rules = Reflect.get(override, "rules");
  return (
    typeof rules === "object" &&
    rules !== null &&
    Object.keys(rules).some((rule) => rule.startsWith(`${PLUGIN}/`))
  );
};

/**
 * Every calendar-day hit beyond the current budgets, and every budget the code
 * no longer reaches, from a lint pass that enables only this plugin with the
 * production scopes (so the census can never disagree with CI about where the
 * rules apply).
 */
const census = (): { excess: string[]; found: Map<string, number> } => {
  const overrides = Reflect.get(oxlintConfig, "overrides");
  const config = {
    categories: { correctness: "off" },
    jsPlugins: [`./.oxlint-plugins/${PLUGIN}.ts`],
    overrides: (Array.isArray(overrides) ? overrides : []).filter(
      isCalendarDayOverride,
    ),
  };
  // Override globs resolve against the config's directory: write it at the
  // repository root for the duration of the run.
  const configPath = path.join(REPO_ROOT, `.${PLUGIN}-census.oxlintrc.json`);
  const reportDirectory = mkdtempSync(path.join(tmpdir(), `${PLUGIN}-`));
  const reportPath = path.join(reportDirectory, "report.json");
  writeFileSync(configPath, JSON.stringify(config));
  try {
    const result = Bun.spawnSync(
      [
        "bun",
        "--bun",
        "oxlint",
        "-c",
        configPath,
        "--format=json",
        ...CENSUS_TARGETS,
      ],
      { cwd: REPO_ROOT, stdout: Bun.file(reportPath), stderr: "pipe" },
    );
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      panic(
        `oxlint exited with ${result.exitCode}: ${result.stderr.toString()}`,
      );
    }
    const output = v.parse(
      LintOutput,
      JSON.parse(readFileSync(reportPath, "utf-8")),
    );
    const excess: string[] = [];
    const found = new Map<string, number>();
    for (const { code, message } of output.diagnostics) {
      if (!code.startsWith(PLUGIN)) {
        continue;
      }
      const stale =
        /^Lower (?<id>.+) in scripts\/calendar-day-ledger\.json from \d+ to (?<found>\d+)/u.exec(
          message,
        )?.groups;
      if (stale?.["id"] !== undefined && stale["found"] !== undefined) {
        found.set(stale["id"], Number(stale["found"]));
        continue;
      }
      const key = /Ledger key: (?<key>.+)$/u.exec(message)?.groups?.["key"];
      if (key === undefined) {
        panic(`unrecognised ${PLUGIN} diagnostic: ${message}`);
      }
      excess.push(key);
    }
    return { excess, found };
  } finally {
    rmSync(configPath, { force: true });
    rmSync(reportDirectory, { force: true, recursive: true });
  }
};

const write = (): number => {
  const current = v.parse(
    Ledger,
    JSON.parse(readFileSync(path.join(REPO_ROOT, LEDGER_REL), "utf-8")),
  );
  const { excess, found } = census();
  const next = new Map<string, LedgerRow>();
  for (const row of current) {
    const count = found.get(row.id) ?? row.count;
    if (count > 0) {
      next.set(row.id, { ...row, count });
    }
  }
  for (const id of excess) {
    const row = next.get(id);
    next.set(
      id,
      row === undefined
        ? { id, count: 1, reason: TODO_REASON }
        : { ...row, count: row.count + 1 },
    );
  }
  const rows = [...next.values()].toSorted((left, right) =>
    left.id < right.id ? -1 : 1,
  );
  writeFileSync(
    path.join(REPO_ROOT, LEDGER_REL),
    `${JSON.stringify(rows, null, 2)}\n`,
  );
  const todo = rows.filter((row) => row.reason === TODO_REASON).length;
  console.log(
    `Wrote ${LEDGER_REL}: ${rows.length} rows, ${expandLedger(rows).length} budgeted sites${todo > 0 ? `, ${todo} need a reason` : ""}.`,
  );
  return todo > 0 ? 1 : 0;
};

if (import.meta.main) {
  process.exit(
    process.argv.includes("--write")
      ? write()
      : runLedgerMembershipGuard({
          ledgerRel: LEDGER_REL,
          repoRoot: REPO_ROOT,
          parseLedger,
          label: PLUGIN,
          remediation:
            "read the day through todayFor(zone) or decide on ctx.dueAt instead of budgeting a new site",
        }),
  );
}
