import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assessBaselineIncrease,
  inspectConfiguration,
  rebaseSnapshot,
  scanAll,
  serializeBaseline,
  type RatchetMetric,
} from "./ratchet";

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
  test("serialization retains metric order and derives every total on round trip", () => {
    for (let allowance = 0; allowance < 12; allowance += 1) {
      const first =
        allowance === 0
          ? snapshot({})
          : snapshot({ "a.ts": allowance, "z.ts": 2 });
      const baseline = {
        second: snapshot({ "b.ts": 1 }),
        first,
      };
      const serialized = serializeBaseline(baseline, ["first", "second"]);
      expect(serialized).not.toContain('"count"');
      expect(serialized.indexOf('"first"')).toBeLessThan(
        serialized.indexOf('"second"'),
      );
      expect(
        inspectConfiguration(
          [{ id: "first" }, { id: "second" }],
          JSON.parse(serialized),
        ),
      ).toEqual({
        status: "valid",
        baseline,
      });
      expect(serializeBaseline(baseline, ["first", "second"])).toBe(serialized);
    }
  });

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

  test("raised budgets require the writer's exact per-file delta, including retained headroom", () => {
    const mergeBaseEntry = snapshot({ "a.ts": 5, "b.ts": 4 });
    const base = snapshot({ "a.ts": 3, "b.ts": 2 });
    const head = snapshot({ "a.ts": 4, "b.ts": 2 });
    const candidate = rebaseSnapshot({ mergeBaseEntry, base, head });
    expect(candidate).toEqual(snapshot({ "a.ts": 6, "b.ts": 4 }));
    const assess = (entry: ReturnType<typeof snapshot>) =>
      assessBaselineIncrease({
        baseline: { "test-metric": entry },
        mergeBaseBaseline: { "test-metric": mergeBaseEntry },
        current: { "test-metric": head },
        baseSnapshot: { "test-metric": base },
        metrics: [metric],
      });
    expect(assess(candidate)).toEqual([]);
    expect(assess(snapshot({ "a.ts": 7, "b.ts": 3 })).length).toBeGreaterThan(
      0,
    );
    expect(assess(snapshot({ "a.ts": 5, "b.ts": 5 })).length).toBeGreaterThan(
      0,
    );
    expect(assess(snapshot({ "a.ts": 4, "b.ts": 4 }))).toEqual([]);
  });

  test("full regeneration tightens unused headroom while recording a real regression", () => {
    const assess = (entry: ReturnType<typeof snapshot>) =>
      assessBaselineIncrease({
        baseline: { "test-metric": entry },
        mergeBaseBaseline: { "test-metric": snapshot({ "a.ts": 2 }) },
        current: { "test-metric": snapshot({ "a.ts": 3 }) },
        baseSnapshot: { "test-metric": snapshot({ "a.ts": 1 }) },
        metrics: [metric],
      });
    expect(assess(snapshot({ "a.ts": 3 }))).toEqual([]);
    expect(assess(snapshot({ "a.ts": 4 }))).toEqual([]);
    expect(assess(snapshot({ "a.ts": 5 })).length).toBeGreaterThan(0);
    expect(
      assess(snapshot({ "a.ts": 3, "absent.ts": 1 })).length,
    ).toBeGreaterThan(0);
  });
});

const ROOT = path.resolve(import.meta.dir, "..");
const BASELINE = "scripts/ratchet-baseline.json";
const FIRST = "apps/api/src/a.ts";
const LAST = "apps/api/src/z.ts";
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

// Copy the real writer and its import closure; the clone's scans and Git
// history stay small while both branches execute production CLI behavior.
const withClone = (exercise: (root: string) => void) => {
  const temporary = mkdtempSync(path.join(tmpdir(), "ratchet-derived-totals-"));
  const seed = path.join(temporary, "seed");
  const clone = path.join(temporary, "clone");
  try {
    mkdirSync(seed);
    for (const relative of [
      "scripts/ratchet.ts",
      "scripts/baseline-paths.ts",
      "scripts/db-await-in-loop.ts",
      "scripts/lint-suppressions.ts",
      "scripts/ownership.ts",
      "scripts/parse-memo.ts",
      "scripts/generated-artifacts.ts",
      "scripts/result-boundary-globs.ts",
      "scripts/root-connection-shapes.ts",
      "scripts/source-globs.ts",
      "packages/api-contract/src/mcp.ts",
      "packages/scripts/src/typescript-program.ts",
      "packages/scripts/src/tsgo-compiler-options.ts",
    ]) {
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
    write({ root: seed, relative: LAST, contents: casts(2) });
    symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(seed, "node_modules"),
      "dir",
    );
    git(seed, "init", "-b", "main");
    git(seed, "config", "user.name", "Ratchet fixture");
    git(seed, "config", "user.email", "ratchet@example.invalid");
    const initial = scanAll(seed);
    write({
      root: seed,
      relative: BASELINE,
      contents: serializeBaseline(initial, Object.keys(initial)),
    });
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

test("CI rejects hand-raised budgets and accepts writer deltas and decreases", () => {
  withClone((root) => {
    git(root, "checkout", "-b", "raise");
    const original = readFileSync(path.join(root, BASELINE), "utf-8");
    const inspection = inspectConfiguration(
      Object.keys(JSON.parse(original)).map((id) => ({ id })),
      JSON.parse(original),
    );
    expect(inspection.status).toBe("valid");
    if (inspection.status !== "valid") {
      panic(inspection.errors.join("\n"));
    }
    const entry = inspection.baseline["as-casts"];
    expect(entry?.files[FIRST]).toBe(2);
    if (entry === undefined) {
      panic("fixture as-casts metric missing");
    }
    entry.files[FIRST] = 3;
    entry.count += 1;
    write({
      root,
      relative: BASELINE,
      contents: serializeBaseline(
        inspection.baseline,
        Object.keys(inspection.baseline),
      ),
    });
    commit(root, "hand raise");
    const rejected = run(root, [
      process.execPath,
      "scripts/ratchet.ts",
      "--check",
    ]);
    expect(rejected.code, rejected.output).toBe(1);
    expect(rejected.output).toContain("as-casts");
    expect(rejected.output).toContain("unrecorded baseline increase");
    for (const scenario of [
      {
        name: "baseline for an absent file",
        file: "apps/api/src/absent.ts",
        allowance: 1,
        sources: [],
      },
      {
        name: "baseline exceeds the source delta",
        file: FIRST,
        allowance: 4,
        sources: [{ file: FIRST, count: 3 }],
      },
    ]) {
      git(root, "reset", "--hard", "origin/main");
      const candidate = inspectConfiguration(
        Object.keys(JSON.parse(original)).map((id) => ({ id })),
        JSON.parse(original),
      );
      if (candidate.status !== "valid") {
        panic(candidate.errors.join("\n"));
      }
      const budget = candidate.baseline["as-casts"];
      if (budget === undefined) {
        panic("fixture as-casts metric missing");
      }
      if (scenario.sources.length === 0) {
        expect(
          run(root, ["git", "cat-file", "-e", `origin/main:${scenario.file}`])
            .code,
        ).not.toBe(0);
      }
      budget.count += scenario.allowance - (budget.files[scenario.file] ?? 0);
      budget.files[scenario.file] = scenario.allowance;
      for (const source of scenario.sources) {
        write({ root, relative: source.file, contents: casts(source.count) });
      }
      write({
        root,
        relative: BASELINE,
        contents: serializeBaseline(
          candidate.baseline,
          Object.keys(candidate.baseline),
        ),
      });
      commit(root, scenario.name);
      const excess = run(root, [
        process.execPath,
        "scripts/ratchet.ts",
        "--check",
      ]);
      expect(excess.code, excess.output).toBe(1);
      expect(excess.output).toContain("as-casts");
      expect(excess.output).toContain("unrecorded baseline increase");
    }
    git(root, "reset", "--hard", "origin/main");
    write({ root, relative: FIRST, contents: casts(3) });
    ratchet(root, "--write");
    commit(root, "writer raise");
    succeed(root, [process.execPath, "scripts/ratchet.ts", "--check"]);
    git(root, "reset", "--hard", "origin/main");
    write({ root, relative: FIRST, contents: casts(1) });
    ratchet(root, "--write");
    commit(root, "writer decrease");
    succeed(root, [process.execPath, "scripts/ratchet.ts", "--check"]);
  });
}, 30_000);

test("the real --write --all and later CI check accept an exact scan with merge-base headroom", () => {
  withClone((root) => {
    // Keep the baseline budget at 2 while the merge-base source counts only 1.
    write({ root, relative: FIRST, contents: casts(1) });
    commit(root, "unused headroom");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(root, "checkout", "-b", "full-regeneration");
    write({ root, relative: FIRST, contents: casts(3) });
    ratchet(root, "--write", "--all");
    const generated = JSON.parse(
      readFileSync(path.join(root, BASELINE), "utf-8"),
    );
    expect(generated["as-casts"].files[FIRST]).toBe(3);
    expect(generated["as-casts"]).not.toHaveProperty("count");
    commit(root, "full regeneration");
    ratchet(root, "--check");
  });
}, 30_000);

test("independent improvements merge cleanly and the real writer has a deterministic fixed point", () => {
  withClone((root) => {
    for (const [branch, file] of [
      ["improve-first", FIRST],
      ["improve-last", LAST],
    ] as const) {
      git(root, "checkout", "-b", branch, "origin/main");
      write({ root, relative: file, contents: casts(1) });
      commit(root, `${branch} source`);
      git(root, "branch", `${branch}-inputs`);
      ratchet(root, "--write");
      const once = readFileSync(path.join(root, BASELINE), "utf-8");
      ratchet(root, "--write");
      expect(readFileSync(path.join(root, BASELINE), "utf-8")).toBe(once);
      commit(root, branch);
    }
    git(
      root,
      "merge-tree",
      "--write-tree",
      "--name-only",
      "improve-first-inputs",
      "improve-last-inputs",
    );
    const merged = git(
      root,
      "merge-tree",
      "--write-tree",
      "--name-only",
      "improve-first",
      "improve-last",
    );
    expect(merged).toMatch(/^[a-f0-9]{40}$/u);
    git(root, "read-tree", "--reset", "-u", merged);
    const mergedBytes = readFileSync(path.join(root, BASELINE), "utf-8");
    expect(mergedBytes).not.toContain('"count"');
    ratchet(root, "--write");
    expect(readFileSync(path.join(root, BASELINE), "utf-8")).toBe(mergedBytes);
    ratchet(root, "--write");
    expect(readFileSync(path.join(root, BASELINE), "utf-8")).toBe(mergedBytes);
  });
}, 30_000);
