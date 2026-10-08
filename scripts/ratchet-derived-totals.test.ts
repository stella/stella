import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  allowanceAdjustmentCommand,
  allowanceRemovalCommand,
  inspectConfiguration,
  scanAll,
  type RatchetMetric,
} from "./ratchet";
import ratchetDefinitionPaths from "./ratchet-definition-paths.json" with { type: "json" };
import { workflowJobSteps, workflowStepByName } from "./workflow-steps";

const metric = {
  id: "test-metric",
  scope: "repo",
  description: "fixture",
  count: () => ({ count: 0, files: {} }),
} satisfies RatchetMetric;
const snapshot = (files: Record<string, number>) => ({
  count: Object.values(files).reduce((total, value) => total + value, 0),
  files,
});

describe("derived ratchet budgets", () => {
  test("historical totals must agree with their file budgets", () => {
    expect(
      inspectConfiguration([metric], {
        "test-metric": { count: 3, files: { "a.ts": 2 } },
      }).status,
    ).toBe("invalid");
    expect(
      inspectConfiguration([metric], {
        "test-metric": snapshot({ "a.ts": 2 }),
      }),
    ).toEqual({
      status: "valid",
      baseline: { "test-metric": snapshot({ "a.ts": 2 }) },
    });
  });
});

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE = "scripts/ratchet-baseline.json";
const FIRST = "apps/api/src/a.ts";
const casts = (count: number) =>
  `${Array.from(
    { length: count },
    (_, index) => `export const item${index} = value${index} as unknown;`,
  ).join("\n")}\n`;

const run = (cwd: string, command: readonly string[]) => {
  const result = Bun.spawnSync([...command], {
    cwd,
    env: {
      ...process.env,
      RATCHET_BASE_REF: undefined,
      CI: "true",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
};
const succeed = (cwd: string, command: readonly string[]) => {
  const result = run(cwd, command);
  expect(result, result.output).toMatchObject({ code: 0 });
  return result.output.trim();
};
const git = (cwd: string, ...args: string[]) => succeed(cwd, ["git", ...args]);
const ratchet = (cwd: string, ...args: string[]) =>
  succeed(cwd, [process.execPath, "scripts/ratchet.ts", ...args]);
type WriteOptions = { root: string; relative: string; contents: string };
const write = ({ root, relative, contents }: WriteOptions) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), contents);
};
const commit = (root: string, message: string) => {
  git(root, "add", ".");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", message);
};

// Copy the real guard and its import closure; the clone's scans and Git
// history stay small while both branches execute production CLI behavior.
const withClone = (exercise: (root: string) => void) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "ratchet-derived-totals-"));
  const seed = path.join(temporary, "seed");
  const clone = path.join(temporary, "clone");
  try {
    mkdirSync(seed);
    for (const relative of ratchetDefinitionPaths.flatMap((pattern) => [
      ...new Bun.Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true }),
    ])) {
      mkdirSync(path.dirname(path.join(seed, relative)), { recursive: true });
      copyFileSync(path.join(ROOT, relative), path.join(seed, relative));
    }
    write({ root: seed, relative: "package.json", contents: "{}\n" });
    write({ root: seed, relative: "bun.lock", contents: '{"packages":{}}\n' });
    write({ root: seed, relative: ".gitignore", contents: "node_modules\n" });
    write({ root: seed, relative: FIRST, contents: casts(2) });
    write({
      root: seed,
      relative: "apps/api/src/middle.ts",
      contents: casts(2),
    });
    write({ root: seed, relative: "apps/api/src/z.ts", contents: casts(2) });
    symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(seed, "node_modules"),
      "dir",
    );
    git(seed, "init", "-b", "main");
    git(seed, "config", "user.name", "Ratchet fixture");
    git(seed, "config", "user.email", "ratchet@example.invalid");
    commit(seed, "fixture base");
    git(temporary, "clone", "--quiet", seed, clone);
    git(clone, "config", "user.name", "Ratchet fixture");
    git(clone, "config", "user.email", "ratchet@example.invalid");
    symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(clone, "node_modules"),
      "dir",
    );
    exercise(clone);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

test("a metric increase fails even with a forged committed budget", () => {
  withClone((root) => {
    write({ root, relative: FIRST, contents: casts(3) });
    write({
      root,
      relative: BASELINE,
      contents:
        '{"as-casts":{"count":999,"files":{"apps/api/src/a.ts":999}}}\n',
    });
    commit(root, "raise with forged budget");
    const rejected = run(root, [
      process.execPath,
      "scripts/ratchet.ts",
      "--check",
    ]);
    expect(rejected.code, rejected.output).toBe(1);
    expect(rejected.output).toContain("as-casts: 6 -> 7");
    expect(rejected.output).toContain("measured base tree");
    // Mutation proof: substituting a head measurement for the base makes this
    // exact regression pass, so the exit-code assertion binds base selection.
    const script = path.join(root, "scripts/ratchet.ts");
    const original = readFileSync(script, "utf-8");
    const mutant = original.replaceAll(
      "const baseline = scanMergeBase({ ref: base, previous: head });",
      "const baseline = scanAll(REPO_ROOT);",
    );
    expect(mutant).not.toBe(original);
    writeFileSync(script, mutant);
    const bypassed = run(root, [
      process.execPath,
      "scripts/ratchet.ts",
      "--check",
    ]);
    expect(bypassed.code, bypassed.output).toBe(0);
  });
}, 30_000);

test("decreases need no baseline and merging main needs no generated edit", () => {
  withClone((root) => {
    git(root, "checkout", "-b", "improve");
    write({ root, relative: FIRST, contents: casts(1) });
    commit(root, "branch improvement");
    const before = git(root, "status", "--porcelain");
    expect(ratchet(root, "--check")).toContain("as-casts dropped 6 -> 5");
    expect(git(root, "status", "--porcelain")).toBe(before);
    git(root, "checkout", "-b", "advance-main", "origin/main");
    write({ root, relative: "apps/api/src/z.ts", contents: casts(1) });
    commit(root, "main improvement");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "checkout", "improve");
    git(root, "merge", "--no-edit", "origin/main");
    expect(ratchet(root, "--check")).toContain("as-casts dropped 5 -> 4");
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(git(root, "ls-files", BASELINE)).toBe("");
  });
}, 30_000);

test("the measured base overrides stale headroom and explicit merge-group bases", () => {
  withClone((root) => {
    const oldBase = git(root, "rev-parse", "HEAD");
    write({ root, relative: FIRST, contents: casts(1) });
    write({
      root,
      relative: BASELINE,
      contents: '{"as-casts":{"files":{"apps/api/src/a.ts":100}}}\n',
    });
    commit(root, "lower source with stale budget");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    write({ root, relative: FIRST, contents: casts(2) });
    const rejected = run(root, [
      process.execPath,
      "scripts/ratchet.ts",
      "--check",
    ]);
    expect(rejected.code, rejected.output).toBe(1);
    expect(rejected.output).toContain("as-casts: 5 -> 6");
    expect(ratchet(root, "--check", "--base", oldBase)).toContain(
      "ratchet --check: OK",
    );
    const badBase = run(root, [
      process.execPath,
      "scripts/ratchet.ts",
      "--check",
      "--base",
      "absent-ref",
    ]);
    expect(badBase.code).not.toBe(0);
    expect(badBase.output).toContain("rev-parse failed");
  });
}, 30_000);

test("--head measures a commit as data with that commit's allowances", () => {
  withClone((root) => {
    const base = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-b", "raise");
    write({ root, relative: FIRST, contents: casts(3) });
    // The head's own checker would pass anything; only the base's may run.
    write({
      root,
      relative: "scripts/ratchet.ts",
      contents: "process.exit(0);\n",
    });
    commit(root, "raise with a permissive checker");
    const raised = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "--quiet", base);
    const headCheck = (head: string) =>
      run(root, [
        process.execPath,
        "scripts/ratchet.ts",
        "--check",
        "--base",
        base,
        "--head",
        head,
      ]);
    const rejected = headCheck(raised);
    expect(rejected.code, rejected.output).toBe(1);
    expect(rejected.output).toContain("as-casts: 6 -> 7");
    const hint =
      /Add (scripts\/ratchet-allowances\/\S+\.json) so added deltas total exactly 1: (\{.*\})$/mu.exec(
        rejected.output,
      );
    const [, allowancePath, allowance] = hint ?? [];
    if (allowancePath === undefined || allowance === undefined) {
      throw new Error(`no allowance hint in: ${rejected.output}`);
    }
    // An allowance in the worktree funds nothing; the head's commit decides.
    write({ root, relative: allowancePath, contents: `${allowance}\n` });
    expect(headCheck(raised).code).toBe(1);
    rmSync(path.join(root, allowancePath));
    git(root, "checkout", "--quiet", "raise");
    write({ root, relative: allowancePath, contents: `${allowance}\n` });
    commit(root, "fund the increase");
    const funded = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "--quiet", base);
    const accepted = headCheck(funded);
    expect(accepted.code, accepted.output).toBe(0);
    expect(accepted.output).toContain("ratchet --check: OK");
  });
}, 30_000);

test("a counter cannot supply an inflated total detached from its files", () => {
  expect(() =>
    scanAll(ROOT, {
      metrics: [
        { ...metric, count: () => ({ count: 999, files: { "a.ts": 1 } }) },
      ],
    }),
  ).toThrow("does not equal its per-file total");
});

const workflow = Bun.YAML.parse(
  readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf-8",
  ),
);
const policySteps = workflowJobSteps(workflow, "ci-checks-policy");
const selectionStep = workflowStepByName(
  policySteps,
  "Select measured ratchet base from the target branch",
);
const ratchetGuardStep = workflowStepByName(policySteps, "Ratchet guard");
const selectionCommand = selectionStep["run"];
if (typeof selectionCommand !== "string") {
  throw new TypeError("Ratchet base selection step must have a run command");
}

test("CI selects the merge base on PRs and the event base on merge groups", () => {
  expect(selectionStep["env"]).toMatchObject({
    MERGE_GROUP_BASE_SHA: `\${{ github.event.merge_group.base_sha }}`,
    BASE_REF: `\${{ github.base_ref || 'main' }}`,
  });
  expect(policySteps.indexOf(selectionStep)).toBeLessThan(
    policySteps.indexOf(ratchetGuardStep),
  );
  withClone((root) => {
    const base = git(root, "rev-parse", "HEAD");
    write({ root, relative: FIRST, contents: casts(1) });
    commit(root, "new main");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const newBase = git(root, "rev-parse", "HEAD");
    expect(newBase).not.toBe(base);
    for (const eventBase of ["", base]) {
      const output = path.join(root, "github-env");
      writeFileSync(output, "");
      const selected = Bun.spawnSync(["bash", "-c", selectionCommand], {
        cwd: root,
        env: {
          ...process.env,
          GITHUB_ENV: output,
          MERGE_GROUP_BASE_SHA: eventBase,
          BASE_REF: "main",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(selected.exitCode, selected.stderr.toString()).toBe(0);
      expect(readFileSync(output, "utf-8")).toBe(
        `RATCHET_BASE_REF=${eventBase || newBase}\n`,
      );
      const checked = Bun.spawnSync(
        [process.execPath, "scripts/ratchet.ts", "--check"],
        {
          cwd: root,
          env: { ...process.env, RATCHET_BASE_REF: eventBase || newBase },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(checked.exitCode, checked.stderr.toString()).toBe(0);
      expect(checked.stdout.toString()).toContain(`(${eventBase || newBase})`);
    }
  });
}, 30_000);

test("removed writer options fail explicitly", () => {
  const result = run(ROOT, [process.execPath, "scripts/ratchet.ts", "--write"]);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("unsupported ratchet option: --write");
});

test("the lint planner inherits only result-boundary debt measured in the base tree", () => {
  withClone((root) => {
    const legacy = "apps/api/src/lib/legacy.ts";
    const fresh = "apps/api/src/lib/fresh.ts";
    write({ root, relative: legacy, contents: 'throw new Error("legacy");\n' });
    commit(root, "base debt");
    const base = git(root, "rev-parse", "HEAD");
    write({ root, relative: legacy, contents: "export const clean = 1;\n" });
    write({ root, relative: fresh, contents: 'throw new Error("fresh");\n' });
    const measured = succeed(root, [
      process.execPath,
      "--eval",
      'import { measureResultBoundaryDebt } from "./scripts/ratchet"; console.log(JSON.stringify([...measureResultBoundaryDebt(process.argv.at(-1) ?? "")]));',
      base,
    ]);
    expect(JSON.parse(measured)).toEqual([legacy]);
  });
}, 30_000);

const ALLOWANCE = "scripts/ratchet-allowances/fixture-increase.json";
const fund = (root: string, allowance: unknown, relative = ALLOWANCE) =>
  write({ root, relative, contents: `${JSON.stringify(allowance)}\n` });
const check = (root: string, ...args: string[]) =>
  run(root, [process.execPath, "scripts/ratchet.ts", "--check", ...args]);

for (const { name, count, delta, code, diagnostic } of [
  {
    name: "funded increase passes",
    count: 3,
    delta: 1,
    code: 0,
    diagnostic: "ratchet --check: OK",
  },
  {
    name: "under-funded increase fails",
    count: 4,
    delta: 1,
    code: 1,
    diagnostic: "actual increase 2, funded 1 (unfunded increase)",
  },
  {
    name: "over-funded increase fails",
    count: 3,
    delta: 2,
    code: 1,
    diagnostic: "actual increase 1, funded 2 (over-funded)",
  },
  {
    name: "allowance without an increase fails",
    count: 2,
    delta: 1,
    code: 1,
    diagnostic: "actual increase 0, funded 1",
  },
]) {
  test(
    name,
    () => {
      withClone((root) => {
        write({ root, relative: FIRST, contents: casts(count) });
        fund(root, {
          metric: "as-casts",
          delta,
          reason: "Required fixture conversion",
        });
        commit(root, "change with allowance");
        const result = check(root);
        expect(result.code, result.output).toBe(code);
        expect(result.output).toContain(diagnostic);
        if (code !== 0) {
          expect(result.output).toContain(ALLOWANCE);
          if (count > 2) {
            expect(result.output).toContain(
              `mkdir -p 'scripts/ratchet-allowances' && printf '%s\\n'`,
            );
            expect(result.output).toContain(`> '${ALLOWANCE}'`);
          } else {
            expect(result.output).toContain(`rm -- '${ALLOWANCE}'`);
          }
          expect(result.output).toContain("bun scripts/ratchet.ts --check");
        }
      });
    },
    30_000,
  );
}

test("multiple added allowances must sum to the actual increase", () => {
  withClone((root) => {
    write({ root, relative: FIRST, contents: casts(4) });
    for (const slug of ["one", "two"]) {
      fund(
        root,
        { metric: "as-casts", delta: 1, reason: "Fixture conversion" },
        `scripts/ratchet-allowances/${slug}.json`,
      );
    }
    commit(root, "split funding");
    expect(check(root).code).toBe(0);
  });
}, 30_000);

test("allowance repair commands preserve each complete filename and JSON payload", () => {
  const root = mkdtempSync(path.join(tmpdir(), "allowance-command-"));
  try {
    const target = "scripts/ratchet-allowances/one space;quote'.json";
    const remove = "scripts/ratchet-allowances/two space;quote'.json";
    const untouched = "scripts/ratchet-allowances/unchanged.json";
    for (const relative of [target, remove, untouched]) {
      write({ root, relative, contents: "unchanged bytes\n" });
    }
    const template = {
      metric: "as-casts",
      delta: 1,
      reason: "Fixture's adjustment",
    };
    const command = allowanceAdjustmentCommand({
      target,
      remove: [remove],
      template,
    });
    succeed(root, ["bash", "-euo", "pipefail", "-c", command]);
    expect(JSON.parse(readFileSync(path.join(root, target), "utf-8"))).toEqual(
      template,
    );
    expect(
      readdirSync(path.join(root, "scripts/ratchet-allowances")).toSorted(),
    ).toEqual([path.basename(target), path.basename(untouched)].toSorted());
    expect(readFileSync(path.join(root, untouched), "utf-8")).toBe(
      "unchanged bytes\n",
    );
    succeed(root, [
      "bash",
      "-euo",
      "pipefail",
      "-c",
      allowanceRemovalCommand([target]),
    ]);
    expect(readdirSync(path.join(root, "scripts/ratchet-allowances"))).toEqual([
      path.basename(untouched),
    ]);
    expect(readFileSync(path.join(root, untouched), "utf-8")).toBe(
      "unchanged bytes\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the adjustment command consolidates every added allowance for the metric", () => {
  withClone((root) => {
    write({ root, relative: FIRST, contents: casts(3) });
    const files = [
      "scripts/ratchet-allowances/one.json",
      "scripts/ratchet-allowances/two.json",
    ] as const;
    for (const file of files) {
      fund(root, { metric: "as-casts", delta: 1, reason: "Fixture" }, file);
    }
    commit(root, "split excess funding");
    const result = check(root);
    expect(result.code).toBe(1);
    expect(result.output).toContain("actual increase 1, funded 2");
    expect(result.output).toContain(
      `Adjust ${files.join(", ")}, merging their funding into ${files[0]}`,
    );
    const command = /After deciding the increase is required, run: ([^\n]+)/u
      .exec(result.output)
      ?.at(1);
    if (command === undefined) {
      throw new TypeError("Missing allowance adjustment command");
    }
    succeed(root, ["bash", "-euo", "pipefail", "-c", command]);
    commit(root, "consolidate funding");
    const adjusted = check(root);
    expect(adjusted.code, adjusted.output).toBe(0);
  });
}, 30_000);

test("an unmerged main improvement cannot change the PR funding requirement", () => {
  withClone((root) => {
    const fork = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-b", "advance-main");
    write({ root, relative: FIRST, contents: casts(1) });
    commit(root, "main improvement after fork");
    const main = git(root, "rev-parse", "HEAD");
    git(root, "update-ref", "refs/remotes/origin/main", main);
    git(root, "checkout", "-b", "feature", fork);
    write({ root, relative: FIRST, contents: casts(3) });
    fund(root, { metric: "as-casts", delta: 1, reason: "Fixture conversion" });
    commit(root, "fund branch increase relative to fork");
    expect(git(root, "merge-base", "origin/main", "HEAD")).toBe(fork);
    expect(main).not.toBe(fork);
    const result = check(root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("ratchet --check: OK");
    const againstTip = check(root, "--base", main);
    expect(againstTip.code, againstTip.output).toBe(1);
    expect(againstTip.output).toContain("actual increase 2, funded 1");
  });
}, 30_000);

test("working tree allowance edits cannot fund a committed increase", () => {
  withClone((root) => {
    write({ root, relative: FIRST, contents: casts(4) });
    fund(root, { metric: "as-casts", delta: 1, reason: "Fixture conversion" });
    commit(root, "commit insufficient funding");
    fund(root, {
      metric: "as-casts",
      delta: 2,
      reason: "Uncommitted correction",
    });
    const result = check(root);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("actual increase 2, funded 1");
    expect(result.output).toContain(ALLOWANCE);
  });
}, 30_000);

test("base allowances stay inert even when edited; counting them kills the guard", () => {
  withClone((root) => {
    fund(root, {
      metric: "as-casts",
      delta: 1,
      reason: "Historical conversion",
    });
    commit(root, "historical allowance");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    write({ root, relative: FIRST, contents: casts(3) });
    fund(root, {
      metric: "as-casts",
      delta: 1,
      reason: "Edited historical reason",
    });
    commit(root, "later increase");
    const result = check(root);
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("actual increase 1, funded 0");
    expect(result.output).toContain('"delta":1');
    const script = path.join(root, "scripts/ratchet.ts");
    const original = readFileSync(script, "utf-8");
    const mutant = original.replace(
      "if (inherited.has(filename)) {",
      "if (false) {",
    );
    expect(mutant).not.toBe(original);
    writeFileSync(script, mutant);
    // The same exit-code assertion goes red with base funding enabled.
    expect(check(root).code).toBe(0);
  });
}, 30_000);

test("pruning an allowance inherited from the base passes", () => {
  withClone((root) => {
    fund(root, {
      metric: "as-casts",
      delta: 1,
      reason: "Historical conversion",
    });
    commit(root, "historical allowance");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    rmSync(path.join(root, ALLOWANCE));
    commit(root, "prune historical allowance");
    expect(check(root).code).toBe(0);
  });
}, 30_000);

for (const { name, allowance, diagnostic } of [
  {
    name: "per-file allowance requires a file",
    allowance: {
      metric: "direct-root-connection-imports",
      delta: 1,
      reason: "Fixture",
    },
    diagnostic: "requires file",
  },
  {
    name: "report-only metrics reject allowances",
    allowance: {
      metric: "lockfile-package-entries",
      delta: 1,
      reason: "Fixture",
    },
    diagnostic: "report-only metric takes no allowances",
  },
  {
    name: "empty reasons fail",
    allowance: { metric: "as-casts", delta: 1, reason: "  " },
    diagnostic: "non-empty reason",
  },
  {
    name: "unknown metrics fail",
    allowance: { metric: "absent-metric", delta: 1, reason: "Fixture" },
    diagnostic: "unknown metric",
  },
  {
    name: "unknown allowance keys fail",
    allowance: { metric: "as-casts", delta: 1, reason: "Fixture", extra: true },
    diagnostic: "no unknown keys",
  },
  {
    name: "total metrics forbid a file",
    allowance: { metric: "as-casts", file: FIRST, delta: 1, reason: "Fixture" },
    diagnostic: "forbids file",
  },
  {
    name: "fractional deltas fail",
    allowance: { metric: "as-casts", delta: 0.5, reason: "Fixture" },
    diagnostic: "positive integer delta",
  },
  {
    name: "zero deltas fail",
    allowance: { metric: "as-casts", delta: 0, reason: "Fixture" },
    diagnostic: "positive integer delta",
  },
  {
    name: "unsafe repository paths fail",
    allowance: {
      metric: "direct-root-connection-imports",
      file: "../escape.ts",
      delta: 1,
      reason: "Fixture",
    },
    diagnostic: "requires file as a repository path",
  },
]) {
  test(
    name,
    () => {
      withClone((root) => {
        fund(root, allowance);
        commit(root, "invalid allowance");
        const result = check(root);
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain(diagnostic);
        expect(result.output).toContain(ALLOWANCE);
      });
    },
    30_000,
  );
}

test("per-file funding cannot move to another file even when the total is unchanged", () => {
  withClone((root) => {
    const oldFile = "apps/api/src/old.ts";
    const newFile = "apps/api/src/new.ts";
    const occurrence = 'import { rootDb } from "@/db/root";\n';
    write({ root, relative: oldFile, contents: occurrence });
    commit(root, "base per-file occurrence");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    write({ root, relative: oldFile, contents: "" });
    write({ root, relative: newFile, contents: occurrence });
    fund(root, {
      metric: "direct-root-connection-imports",
      file: oldFile,
      delta: 1,
      reason: "Fixture move",
    });
    commit(root, "fund wrong file");
    const rejected = check(root);
    expect(rejected.code, rejected.output).toBe(1);
    expect(rejected.output).toContain(
      `direct-root-connection-imports (${newFile}): actual increase 1, funded 0`,
    );
    expect(rejected.output).toContain("actual increase 0, funded 1");
    fund(root, {
      metric: "direct-root-connection-imports",
      file: newFile,
      delta: 1,
      reason: "Fixture move",
    });
    commit(root, "fund destination file");
    const accepted = check(root);
    expect(accepted.code, accepted.output).toBe(0);
  });
}, 30_000);

test("merge-group base_sha funds only allowances absent from that event base", () => {
  withClone((root) => {
    const eventBase = git(root, "rev-parse", "HEAD");
    fund(root, { metric: "as-casts", delta: 1, reason: "Fixture conversion" });
    commit(root, "main allowance");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    write({ root, relative: FIRST, contents: casts(3) });
    commit(root, "merge group increase");
    const selected = Bun.spawnSync(["bash", "-c", selectionCommand], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_ENV: path.join(root, "github-env"),
        MERGE_GROUP_BASE_SHA: eventBase,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(selected.exitCode, selected.stderr.toString()).toBe(0);
    const selectedBase = readFileSync(path.join(root, "github-env"), "utf-8")
      .trim()
      .split("=")
      .at(1);
    expect(selectedBase).toBe(eventBase);
    const accepted = check(root, "--base", selectedBase ?? "");
    expect(accepted.code, accepted.output).toBe(0);
    const inherited = check(root);
    expect(inherited.code, inherited.output).toBe(1);
    expect(inherited.output).toContain("actual increase 1, funded 0");
  });
}, 30_000);

for (const allowanceChange of ["added", "changed"] as const) {
  test(`an allowance ${allowanceChange} for paint transitions can accompany its utility without invalidating the base`, () => {
    withClone((root) => {
      const relative =
        allowanceChange === "added"
          ? "packages/ui/src/components/paint-control.ts"
          : "packages/ui/src/components/input-control.ts";
      write({
        root,
        relative,
        contents: 'export const style = "transition-opacity";\n',
      });
      commit(root, "base control without paint utility");
      git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      const script = path.join(root, "scripts/ratchet.ts");
      const original = readFileSync(script, "utf-8");
      const utility = "transition-colors";
      const updated =
        allowanceChange === "added"
          ? original.replace(
              "> = new Map([",
              () =>
                `> = new Map([ [${JSON.stringify(relative)}, { utility: ${JSON.stringify(utility)}, reason: "fixture paint exception" }],`,
            )
          : original.replace(
              "[transition:background-color_5000000s_ease-in-out_0s]",
              () => utility,
            );
      expect(updated).not.toBe(original);
      writeFileSync(script, updated);
      write({
        root,
        relative,
        contents: `export const style = "${utility}";\n`,
      });
      commit(root, "allow the control paint utility");
      const accepted = check(root);
      expect(accepted.code, accepted.output).toBe(0);
      expect(accepted.output).toContain("ratchet --check: OK");

      // Restoring head-only consistency checking on base must reject this PR.
      const mutant = updated.replace(
        'allowed === 0 && role === "head"',
        "allowed === 0",
      );
      expect(mutant).not.toBe(updated);
      writeFileSync(script, mutant);
      const rejectedBase = check(root);
      expect(rejectedBase.code, rejectedBase.output).not.toBe(0);
      expect(rejectedBase.output).toContain(
        `allowance for ${relative} no longer matches`,
      );
      writeFileSync(script, updated);

      // A stale entry on the working head still fails before comparison.
      write({
        root,
        relative,
        contents: 'export const style = "transition-opacity";\n',
      });
      const rejectedHead = check(root);
      expect(rejectedHead.code, rejectedHead.output).not.toBe(0);
      expect(rejectedHead.output).toContain(
        `allowance for ${relative} no longer matches`,
      );
    });
  }, 30_000);
}

test("the base may predate a required domain action definition but head may not lose it", () => {
  withClone((root) => {
    const relative = "apps/api/scripts/lib/capability-catalog.ts";
    write({
      root,
      relative,
      contents: 'export const unrelated = "fixture";\n',
    });
    commit(root, "base before domain actions");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    write({
      root,
      relative,
      contents: 'export const DOMAIN_ACTION_VERBS = ["create"] as const;\n',
    });
    commit(root, "define domain actions");
    const accepted = check(root);
    expect(accepted.code, accepted.output).toBe(0);
    const script = path.join(root, "scripts/ratchet.ts");
    const original = readFileSync(script, "utf-8");
    const mutant = original.replace(
      'if (role === "base") {\n      return 0;\n    }',
      "",
    );
    expect(mutant).not.toBe(original);
    writeFileSync(script, mutant);
    const rejectedBase = check(root);
    expect(rejectedBase.code, rejectedBase.output).not.toBe(0);
    expect(rejectedBase.output).toContain(
      "capability-domain-action-verbs: DOMAIN_ACTION_VERBS not found",
    );
    writeFileSync(script, original);
    write({
      root,
      relative,
      contents: 'export const unrelated = "fixture";\n',
    });
    const rejected = check(root);
    expect(rejected.code, rejected.output).not.toBe(0);
    expect(rejected.output).toContain(
      "capability-domain-action-verbs: DOMAIN_ACTION_VERBS not found",
    );
  });
}, 30_000);

test("untracked files cannot increase file, duplication, directory or dependency metrics", () => {
  withClone((root) => {
    const libFile = "apps/api/src/lib/domain/helper.ts";
    const helper = `export const duplicateHelperBinding = () => { ${Array.from(
      { length: 25 },
      (_, index) => `const value${index} = source${index} + ${index};`,
    ).join(" ")} };\n`;
    write({ root, relative: libFile, contents: helper });
    commit(root, "tracked helper");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    const before = check(root);
    expect(before.code, before.output).toBe(0);
    const untrackedFiles = [
      ["apps/api/src/untracked.ts", casts(10)],
      ["apps/api/src/lib/untracked/helper.ts", helper],
      ["apps/web/src/lib/domain/helper.ts", helper],
      [
        "packages/untracked/package.json",
        '{"dependencies":{"untracked-dependency":"1.0.0"}}\n',
      ],
    ] as const;
    for (const [relative, contents] of untrackedFiles) {
      write({ root, relative, contents });
    }
    const after = check(root);
    const report = ratchet(root);
    expect(report).toMatch(/as-casts\s+6\s+\(baseline 6, 0\)/u);
    expect(report).toMatch(
      /cross-app-lib-path-copies\s+0\s+\(baseline 0, 0\)/u,
    );
    expect(after.code, after.output).toBe(0);
    expect(after.output).toContain("ratchet --check: OK");
    // Removing the tracked-set boundary makes the same tree regress.
    const script = path.join(root, "scripts/ratchet.ts");
    const original = readFileSync(script, "utf-8");
    const mutant = original.replaceAll(
      "const tree = openSourceTree(REPO_ROOT, { trackedFiles });",
      "const tree = openSourceTree(REPO_ROOT);",
    );
    expect(mutant).not.toBe(original);
    writeFileSync(script, mutant);
    const rejected = check(root);
    expect(rejected.code, rejected.output).toBe(1);
    expect(rejected.output).toContain("as-casts: 6 -> 16");
    expect(rejected.output).toContain("cross-app-lib-path-copies");
    expect(rejected.output).toContain("duplicate-token-blocks");
    expect(rejected.output).toContain("cross-workspace-duplicate-export-names");
    expect(rejected.output).toContain("api-lib-top-level-entries");
    expect(rejected.output).toContain("direct-third-party-declarations");
    writeFileSync(script, original);
    // Staged additions belong to the head scan, and local tracked edits remain visible.
    git(root, "add", "apps/api/src/untracked.ts");
    const staged = check(root);
    expect(staged.code, staged.output).toBe(1);
    expect(staged.output).toContain("as-casts: 6 -> 16");
  });
}, 30_000);

test("malformed ledger and dependency schemas fail in both measurement roles", () => {
  withClone((root) => {
    for (const { relative, contents, diagnostic } of [
      {
        relative: "scripts/internal-module-mock-ledger.json",
        contents: "{}",
        diagnostic: "internal-module-mock ledger must be a JSON array",
      },
      {
        relative: "scripts/parser-validator-call-ledger.json",
        contents: "{}",
        diagnostic: "parser-validator-call ledger must be a JSON array",
      },
      {
        relative: "packages/invalid/package.json",
        contents: '{"dependencies":[]}',
        diagnostic: "dependencies must be an object",
      },
      {
        relative: "packages/invalid/package.json",
        contents: '{"dependencies":{"example":1}}',
        diagnostic: "dependencies values must be strings",
      },
      {
        relative: "packages/invalid/package.json",
        contents: "invalid JSON",
        diagnostic: "must contain a JSON5 object",
      },
    ]) {
      write({ root, relative, contents });
      for (const role of ["head", "base"] as const) {
        expect(() => scanAll(root, { role })).toThrow(diagnostic);
      }
      rmSync(path.join(root, relative));
    }
  });
}, 30_000);

test("the full counter self-test exercises both file and repository measurement contracts", () => {
  withClone((root) => {
    expect(ratchet(root, "--self-test")).toContain("ratchet --self-test: PASS");
  });
}, 30_000);

test("staged removal excludes untracked root manifests and lockfiles from all modes", () => {
  withClone((root) => {
    git(root, "rm", "--cached", "package.json", "bun.lock");
    write({
      root,
      relative: "package.json",
      contents: '{"dependencies":{"untracked":"1.0.0"}}\n',
    });
    write({
      root,
      relative: "bun.lock",
      contents: '{"packages":{"untracked@1.0.0":[]}}\n',
    });
    const result = check(root);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain(
      "lockfile-package-entries: 0 (report only)",
    );
    const report = ratchet(root);
    expect(report).toMatch(
      /direct-third-party-declarations\s+0\s+\(baseline 0, 0\)/u,
    );
    expect(report).toContain("lockfile-package-entries: 0 (report only)");
  });
}, 30_000);

test("lifecycle ratchets reject allowances for direct writes and unmanaged specs", () => {
  withClone((root) => {
    const specs = "apps/api/src/lib/db/transition-specs.ts";
    write({
      root,
      relative: specs,
      contents: "export const TRANSITIONS = {};\n",
    });
    commit(root, "managed fixture base");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    write({
      root,
      relative: FIRST,
      contents: 'db.update(flowRuns).set({ status: "running" });\n',
    });
    write({
      root,
      relative: specs,
      contents:
        'export const TRANSITIONS = { flowRuns: { unmanaged: "fixture reason" } };\n',
    });
    fund(
      root,
      {
        metric: "direct-status-writes",
        file: FIRST,
        delta: 1,
        reason: "Fixture",
      },
      "scripts/ratchet-allowances/direct.json",
    );
    fund(
      root,
      { metric: "unmanaged-transition-specs", delta: 1, reason: "Fixture" },
      "scripts/ratchet-allowances/unmanaged.json",
    );
    commit(root, "attempt lifecycle allowances");
    const rejected = check(root);
    expect(rejected.code, rejected.output).toBe(1);
    expect(rejected.output).toContain(
      "shrink-only metric takes no allowances direct-status-writes",
    );
    expect(rejected.output).toContain(
      "shrink-only metric takes no allowances unmanaged-transition-specs",
    );
  });
}, 30_000);
