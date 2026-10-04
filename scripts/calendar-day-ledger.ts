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
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const ScopeOverrideSchema = v.object({
  files: v.array(v.string()),
  rules: v.record(v.string(), v.unknown()),
});
type ScopeOverride = v.InferOutput<typeof ScopeOverrideSchema>;

const calendarDayOverrides = (): ScopeOverride[] => {
  const overrides = Reflect.get(oxlintConfig, "overrides");
  return (Array.isArray(overrides) ? overrides : [])
    .filter(isCalendarDayOverride)
    .map((override) => v.parse(ScopeOverrideSchema, override));
};

/** Whether `rule` is on for `file` once every override has applied, in order. */
export const ruleApplies = (
  overrides: readonly ScopeOverride[],
  rule: string,
  file: string,
): boolean => {
  let on = false;
  for (const override of overrides) {
    const level = override.rules[`${PLUGIN}/${rule}`];
    if (
      level !== undefined &&
      override.files.some((glob) => new Bun.Glob(glob).match(file))
    ) {
      on = level !== "off";
    }
  }
  return on;
};

/**
 * Rows the lint pass never visits: the file is gone, or the rule no longer
 * applies to it. Lint reports a stale budget only from inside a visited file,
 * so without this check such a row would keep its count and a later file at
 * the same path and spelling could reuse it unreviewed.
 */
export const unreachableRows = (
  rows: readonly LedgerRow[],
  overrides: readonly ScopeOverride[],
  exists: (file: string) => boolean,
): string[] =>
  rows
    .filter((row) => {
      const [rule, file] = row.id.split("::");
      return (
        rule === undefined ||
        file === undefined ||
        !exists(file) ||
        !ruleApplies(overrides, rule, file)
      );
    })
    .map((row) => row.id);

const existsInRepo = (file: string): boolean =>
  existsSync(path.join(REPO_ROOT, file));

const readLedger = (): LedgerRow[] =>
  v.parse(
    Ledger,
    JSON.parse(readFileSync(path.join(REPO_ROOT, LEDGER_REL), "utf-8")),
  );

const checkReachable = (): number => {
  const unreachable = unreachableRows(
    readLedger(),
    calendarDayOverrides(),
    existsInRepo,
  );
  for (const id of unreachable) {
    console.error(
      `${LEDGER_REL}: ${id} budgets a file that is gone or out of the rule's scope; run --write to drop it`,
    );
  }
  return unreachable.length === 0 ? 0 : 1;
};

const selfTestReachability = (): number => {
  const overrides: ScopeOverride[] = [
    { files: ["apps/api/src/**/*.ts"], rules: { [`${PLUGIN}/r`]: "error" } },
    { files: ["apps/api/src/**/*.test.ts"], rules: { [`${PLUGIN}/r`]: "off" } },
  ];
  const row = (file: string): LedgerRow => ({
    id: `r::${file}::f::s`,
    count: 1,
    reason: "self-test budget row",
  });
  const unreachable = unreachableRows(
    [
      row("apps/api/src/a.ts"),
      row("apps/api/src/a.test.ts"),
      row("apps/api/src/gone.ts"),
      row("apps/web/src/b.ts"),
    ],
    overrides,
    (file) => file !== "apps/api/src/gone.ts",
  );
  const expected = [
    "r::apps/api/src/a.test.ts::f::s",
    "r::apps/api/src/gone.ts::f::s",
    "r::apps/web/src/b.ts::f::s",
  ];
  if (JSON.stringify(unreachable) !== JSON.stringify(expected)) {
    console.error(
      `${PLUGIN} --self-test: unreachable rows must be ${expected.join(", ")}; got ${unreachable.join(", ")}`,
    );
    return 1;
  }
  return 0;
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
  const current = readLedger();
  const unreachable = new Set(
    unreachableRows(current, calendarDayOverrides(), existsInRepo),
  );
  const { excess, found } = census();
  const next = new Map<string, LedgerRow>();
  for (const row of current) {
    const count = found.get(row.id) ?? row.count;
    if (count > 0 && !unreachable.has(row.id)) {
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

const main = (args: readonly string[]): number => {
  if (args.includes("--write")) {
    return write();
  }
  const reachable = args.includes("--self-test")
    ? selfTestReachability()
    : checkReachable();
  if (reachable !== 0) {
    return reachable;
  }
  return runLedgerMembershipGuard({
    ledgerRel: LEDGER_REL,
    repoRoot: REPO_ROOT,
    parseLedger,
    label: PLUGIN,
    remediation:
      "read the day through todayFor(zone) or decide on ctx.dueAt instead of budgeting a new site",
  });
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
