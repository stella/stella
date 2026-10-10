// The ledger script behind a lint plugin that budgets existing hits in
// scripts/<plugin>-ledger.json (see .oxlint-plugins/budget-ledger.ts). Each
// row is keyed by `rule::file::enclosing function::spelling` with a count and
// a reason. The lint rules enforce the counts in both directions; this keeps
// the ledger honest:
//
//   --write        regenerate from the code
//   --base <ref>   CI: the ledger only shrinks
//   --self-test    the checks work
//
// Regeneration keeps each surviving row's reason; a new row gets a TODO reason
// that the lint rules and this check reject, so a new budget is a reviewed,
// reasoned edit.

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

const REPO_ROOT = path.resolve(import.meta.dir, "..");

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

const ScopeOverrideSchema = v.object({
  files: v.array(v.string()),
  excludeFiles: v.optional(v.array(v.string())),
  rules: v.record(v.string(), v.unknown()),
});
type ScopeOverride = v.InferOutput<typeof ScopeOverrideSchema>;

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

/** Whether `rule` (plugin-qualified) is on for `file` once every override
 *  has applied, in order. */
export const ruleApplies = (
  overrides: readonly ScopeOverride[],
  rule: string,
  file: string,
): boolean => {
  let on = false;
  for (const override of overrides) {
    const level = override.rules[rule];
    const excluded = (override.excludeFiles ?? []).some((glob) =>
      new Bun.Glob(glob).match(file),
    );
    if (
      level !== undefined &&
      !excluded &&
      override.files.some((glob) => new Bun.Glob(glob).match(file))
    ) {
      on = level !== "off";
    }
  }
  return on;
};

type UnreachableRowsOptions = {
  plugin: string;
  rows: readonly LedgerRow[];
  overrides: readonly ScopeOverride[];
  exists: (file: string) => boolean;
};

/**
 * Rows the lint pass never visits: the file is gone, or the rule no longer
 * applies to it. Lint reports a stale budget only from inside a visited file,
 * so without this check such a row would keep its count and a later file at
 * the same path and spelling could reuse it unreviewed.
 */
export const unreachableRows = ({
  plugin,
  rows,
  overrides,
  exists,
}: UnreachableRowsOptions): string[] =>
  rows
    .filter((row) => {
      const [rule, file] = row.id.split("::");
      return (
        rule === undefined ||
        file === undefined ||
        !exists(file) ||
        !ruleApplies(overrides, `${plugin}/${rule}`, file)
      );
    })
    .map((row) => row.id);

const SELF_TEST_PLUGIN = "self-test";

/** Both ways a scope drops a file: `excludeFiles`, and a later "off". */
const selfTestReachability = (): number => {
  const overrides: ScopeOverride[] = [
    {
      files: ["apps/api/src/**/*.ts"],
      excludeFiles: ["apps/api/src/**/*.test.ts"],
      rules: { [`${SELF_TEST_PLUGIN}/r`]: "error" },
    },
    {
      files: ["apps/api/src/legacy/**/*.ts"],
      rules: { [`${SELF_TEST_PLUGIN}/r`]: "off" },
    },
  ];
  const row = (file: string): LedgerRow => ({
    id: `r::${file}::f::s`,
    count: 1,
    reason: "self-test budget row",
  });
  const unreachable = unreachableRows({
    plugin: SELF_TEST_PLUGIN,
    rows: [
      row("apps/api/src/a.ts"),
      row("apps/api/src/a.test.ts"),
      row("apps/api/src/gone.ts"),
      row("apps/api/src/legacy/c.ts"),
      row("apps/web/src/b.ts"),
    ],
    overrides,
    exists: (file) => file !== "apps/api/src/gone.ts",
  });
  const expected = [
    "r::apps/api/src/a.test.ts::f::s",
    "r::apps/api/src/gone.ts::f::s",
    "r::apps/api/src/legacy/c.ts::f::s",
    "r::apps/web/src/b.ts::f::s",
  ];
  if (JSON.stringify(unreachable) !== JSON.stringify(expected)) {
    console.error(
      `plugin budget ledger --self-test: unreachable rows must be ${expected.join(", ")}; got ${unreachable.join(", ")}`,
    );
    return 1;
  }
  return 0;
};

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, (match) => `\\${match}`);

type PluginBudgetLedgerOptions = {
  /** The plugin's name, as its rules are prefixed in oxlint.config.ts. */
  plugin: string;
  /** Directories the census lints. */
  censusTargets: readonly string[];
  /** The reason a regenerated new row carries until someone writes one. */
  todoReason: string;
  /** What to do instead of budgeting a new site. */
  remediation: string;
  args: readonly string[];
};

export const runPluginBudgetLedger = ({
  plugin,
  censusTargets,
  todoReason,
  remediation,
  args,
}: PluginBudgetLedgerOptions): number => {
  const ledgerRel = `scripts/${plugin}-ledger.json`;

  const isPluginOverride = (override: unknown): boolean => {
    if (typeof override !== "object" || override === null) {
      return false;
    }
    const rules = Reflect.get(override, "rules");
    return (
      typeof rules === "object" &&
      rules !== null &&
      Object.keys(rules).some((rule) => rule.startsWith(`${plugin}/`))
    );
  };

  const pluginOverrides = (): ScopeOverride[] => {
    const overrides = Reflect.get(oxlintConfig, "overrides");
    return (Array.isArray(overrides) ? overrides : [])
      .filter(isPluginOverride)
      .map((override) => v.parse(ScopeOverrideSchema, override));
  };

  const existsInRepo = (file: string): boolean =>
    existsSync(path.join(REPO_ROOT, file));

  const readLedger = (): LedgerRow[] =>
    v.parse(
      Ledger,
      JSON.parse(readFileSync(path.join(REPO_ROOT, ledgerRel), "utf-8")),
    );

  const currentUnreachable = (rows: readonly LedgerRow[]): string[] =>
    unreachableRows({
      plugin,
      rows,
      overrides: pluginOverrides(),
      exists: existsInRepo,
    });

  const checkReachable = (): number => {
    const unreachable = currentUnreachable(readLedger());
    for (const id of unreachable) {
      console.error(
        `${ledgerRel}: ${id} budgets a file that is gone or out of the rule's scope; run --write to drop it`,
      );
    }
    return unreachable.length === 0 ? 0 : 1;
  };

  const staleMessage = new RegExp(
    `^Lower (?<id>.+) in ${escapeRegExp(ledgerRel)} from \\d+ to (?<found>\\d+)`,
    "u",
  );

  /**
   * Every hit beyond the current budgets, and every budget the code no longer
   * reaches, from a lint pass that enables only this plugin with the
   * production scopes (so the census cannot disagree with CI about where the
   * rules apply).
   */
  const census = (): { excess: string[]; found: Map<string, number> } => {
    const config = {
      categories: { correctness: "off" },
      jsPlugins: [`./.oxlint-plugins/${plugin}.ts`],
      overrides: pluginOverrides(),
    };
    // Override globs resolve against the config's directory: write it at the
    // repository root for the duration of the run.
    const configPath = path.join(REPO_ROOT, `.${plugin}-census.oxlintrc.json`);
    const reportDirectory = mkdtempSync(path.join(tmpdir(), `${plugin}-`));
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
          ...censusTargets,
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
        if (!code.startsWith(plugin)) {
          continue;
        }
        const stale = staleMessage.exec(message)?.groups;
        if (stale?.["id"] !== undefined && stale["found"] !== undefined) {
          found.set(stale["id"], Number(stale["found"]));
          continue;
        }
        const key = /Ledger key: (?<key>.+)$/u.exec(message)?.groups?.["key"];
        if (key === undefined) {
          panic(`unrecognised ${plugin} diagnostic: ${message}`);
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
    const unreachable = new Set(currentUnreachable(current));
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
          ? { id, count: 1, reason: todoReason }
          : { ...row, count: row.count + 1 },
      );
    }
    const rows = [...next.values()].toSorted((left, right) =>
      left.id < right.id ? -1 : 1,
    );
    writeFileSync(
      path.join(REPO_ROOT, ledgerRel),
      `${JSON.stringify(rows, null, 2)}\n`,
    );
    const todo = rows.filter((row) => row.reason === todoReason).length;
    console.log(
      `Wrote ${ledgerRel}: ${rows.length} rows, ${expandLedger(rows).length} budgeted sites${todo > 0 ? `, ${todo} need a reason` : ""}.`,
    );
    return todo > 0 ? 1 : 0;
  };

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
    ledgerRel,
    repoRoot: REPO_ROOT,
    parseLedger,
    label: plugin,
    args,
    remediation,
  });
};
