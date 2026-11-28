import { afterAll, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import {
  allowanceAdjustmentCommand,
  allowanceRemovalCommand,
  inspectConfiguration,
  type RatchetMetric,
  scanAll,
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
  for (const file of [
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "1",
    "žluťoučký.ts",
  ]) {
    test(`configuration retains an own count for ${file}`, () => {
      const files = { [file]: 2 };
      expect(
        inspectConfiguration([metric], { "test-metric": snapshot(files) }),
      ).toEqual({
        status: "valid",
        baseline: { "test-metric": snapshot(files) },
      });
    });
  }

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

const MAX_CONCURRENT_SUBPROCESSES = Math.max(
  2,
  Math.min(4, availableParallelism()),
);
let activeSubprocesses = 0;
const subprocessWaiters: (() => void)[] = [];

const withSubprocessSlot = async <T>(work: () => Promise<T>): Promise<T> => {
  if (activeSubprocesses >= MAX_CONCURRENT_SUBPROCESSES) {
    await new Promise<void>((resolve) => {
      subprocessWaiters.push(resolve);
    });
  }
  activeSubprocesses += 1;
  try {
    return await work();
  } finally {
    activeSubprocesses -= 1;
    subprocessWaiters.shift()?.();
  }
};

const spawnEnv = (extra?: Readonly<Record<string, string | undefined>>) => ({
  ...process.env,
  RATCHET_BASE_REF: undefined,
  CI: "true",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  ...extra,
});

const runSync = (cwd: string, command: readonly string[]) => {
  const result = Bun.spawnSync([...command], {
    cwd,
    env: spawnEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    output: result.stdout.toString() + result.stderr.toString(),
  };
};
const succeedSync = (cwd: string, command: readonly string[]) => {
  const result = runSync(cwd, command);
  expect(result, result.output).toMatchObject({ code: 0 });
  return result.output.trim();
};
const gitSync = (cwd: string, ...args: string[]) =>
  succeedSync(cwd, ["git", ...args]);

const run = async (
  cwd: string,
  command: readonly string[],
  extraEnv?: Readonly<Record<string, string | undefined>>,
) =>
  await withSubprocessSlot(async () => {
    const child = Bun.spawn([...command], {
      cwd,
      env: spawnEnv(extraEnv),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output: stdout + stderr };
  });
const succeed = async (cwd: string, command: readonly string[]) => {
  const result = await run(cwd, command);
  expect(result, result.output).toMatchObject({ code: 0 });
  return result.output.trim();
};
const git = async (cwd: string, ...args: string[]) =>
  await succeed(cwd, ["git", ...args]);
const ratchet = async (cwd: string, ...args: string[]) =>
  await succeed(cwd, [process.execPath, "scripts/ratchet.ts", ...args]);
type WriteOptions = { root: string; relative: string; contents: string };
const write = ({ root, relative, contents }: WriteOptions) => {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), contents);
};
const commitSync = (root: string, message: string) => {
  gitSync(root, "add", ".");
  gitSync(root, "-c", "commit.gpgsign=false", "commit", "-m", message);
};
const commit = async (root: string, message: string) => {
  await git(root, "add", ".");
  await git(root, "-c", "commit.gpgsign=false", "commit", "-m", message);
};

// The definition paths list the guard's whole relative import closure (merge
// gates read the list as complete). Imports are followed here too, so the
// clone copies everything and the test below fails on a module the guard
// imports without the list naming it.
const RELATIVE_SPECIFIER = /^\.\.?\//u;
const SCANNED_SOURCE = /\.[cm]?ts$/u;
// The transpiler rejects a hashbang; it carries no imports.
const HASHBANG = /^#!.*/u;
const RATCHET_DEFINITION_CLOSURE = ((): readonly string[] => {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const pending = ratchetDefinitionPaths.flatMap((pattern) => [
    ...new Bun.Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true }),
  ]);
  const closure = new Set<string>();
  for (
    let relative = pending.pop();
    relative !== undefined;
    relative = pending.pop()
  ) {
    if (closure.has(relative)) {
      continue;
    }
    closure.add(relative);
    if (!SCANNED_SOURCE.test(relative)) {
      continue;
    }
    const absolute = path.join(ROOT, relative);
    for (const { path: specifier } of transpiler.scanImports(
      readFileSync(absolute, "utf-8").replace(HASHBANG, ""),
    )) {
      if (RELATIVE_SPECIFIER.test(specifier)) {
        pending.push(
          repoRelativePath(
            ROOT,
            Bun.resolveSync(specifier, path.dirname(absolute)),
          ),
        );
      }
    }
  }
  return [...closure];
})();

const createSeedRepository = (seed: string, branch?: string) => {
  mkdirSync(seed);
  for (const relative of RATCHET_DEFINITION_CLOSURE) {
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
  gitSync(seed, "init", "-b", "main");
  gitSync(seed, "config", "user.name", "Ratchet fixture");
  gitSync(seed, "config", "user.email", "ratchet@example.invalid");
  commitSync(seed, "fixture base");
  if (branch !== undefined) {
    gitSync(seed, "branch", branch);
  }
  // Keep an unreachable object-store entry so the fixture proves cloning uses
  // Git's transport instead of racing a filesystem copy of the live store.
  const objectFanout = path.join(seed, ".git/objects/ff");
  mkdirSync(objectFanout, { recursive: true });
  symlinkSync(
    "missing",
    path.join(objectFanout, "00000000000000000000000000000000000000"),
  );
};

let sharedSeedRoot: string | undefined;
const getSharedSeed = (): string => {
  if (sharedSeedRoot === undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), "ratchet-derived-seed-"));
    const seed = path.join(dir, "seed");
    createSeedRepository(seed);
    sharedSeedRoot = dir;
  }
  return path.join(sharedSeedRoot, "seed");
};

afterAll(() => {
  if (sharedSeedRoot !== undefined) {
    rmSync(sharedSeedRoot, { recursive: true, force: true });
    sharedSeedRoot = undefined;
  }
});

type CloneOptions = {
  branch?: string | undefined;
  mutableOrigin?: boolean | undefined;
};

// Copy the real guard and its import closure; the clone's scans and Git
// history stay small while both branches execute production CLI behavior.
// Read-only fixtures clone from one shared immutable seed; tests that mutate
// `origin` or need a custom remote branch get their own disposable seed.
const withClone = async (
  exercise: (root: string) => Promise<void>,
  options?: string | CloneOptions,
) => {
  const branch = typeof options === "string" ? options : options?.branch;
  const mutableOrigin =
    typeof options === "object" && options.mutableOrigin === true;
  const temporary = mkdtempSync(path.join(tmpdir(), "ratchet-derived-totals-"));
  const clone = path.join(temporary, "clone");
  try {
    const seed =
      branch !== undefined || mutableOrigin
        ? (() => {
            const fresh = path.join(temporary, "seed");
            createSeedRepository(fresh, branch);
            return fresh;
          })()
        : getSharedSeed();
    await git(
      temporary,
      "clone",
      "--quiet",
      // Keep each fixture's object database independent of its seed.
      "--no-local",
      ...(branch === undefined ? [] : ["--single-branch", "--branch", branch]),
      seed,
      clone,
    );
    await git(clone, "config", "user.name", "Ratchet fixture");
    await git(clone, "config", "user.email", "ratchet@example.invalid");
    symlinkSync(
      path.join(ROOT, "node_modules"),
      path.join(clone, "node_modules"),
      "dir",
    );
    await exercise(clone);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
};

test("the definition paths list the guard's whole import closure", () => {
  const listed = new Set(
    ratchetDefinitionPaths.flatMap((pattern) => [
      ...new Bun.Glob(pattern).scanSync({ cwd: ROOT, onlyFiles: true }),
    ]),
  );
  expect(
    RATCHET_DEFINITION_CLOSURE.filter((file) => !listed.has(file)).toSorted(),
  ).toEqual([]);
});

test.concurrent(
  "a metric increase fails even with a forged committed budget",
  async () => {
    await withClone(async (root) => {
      write({ root, relative: FIRST, contents: casts(3) });
      write({
        root,
        relative: BASELINE,
        contents:
          '{"as-casts":{"count":999,"files":{"apps/api/src/a.ts":999}}}\n',
      });
      await commit(root, "raise with forged budget");
      const rejected = await run(root, [
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
      const bypassed = await run(root, [
        process.execPath,
        "scripts/ratchet.ts",
        "--check",
      ]);
      expect(bypassed.code, bypassed.output).toBe(0);
    });
  },
  30_000,
);

test.concurrent(
  "decreases need no baseline and merging main needs no generated edit",
  async () => {
    await withClone(async (root) => {
      await git(root, "checkout", "-b", "improve");
      write({ root, relative: FIRST, contents: casts(1) });
      await commit(root, "branch improvement");
      const before = await git(root, "status", "--porcelain");
      expect(await ratchet(root, "--check")).toContain(
        "as-casts dropped 6 -> 5",
      );
      expect(await git(root, "status", "--porcelain")).toBe(before);
      await git(root, "checkout", "-b", "advance-main", "origin/main");
      write({ root, relative: "apps/api/src/z.ts", contents: casts(1) });
      await commit(root, "main improvement");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      await git(root, "checkout", "improve");
      await git(root, "merge", "--no-edit", "origin/main");
      expect(await ratchet(root, "--check")).toContain(
        "as-casts dropped 5 -> 4",
      );
      expect(await git(root, "status", "--porcelain")).toBe("");
      expect(await git(root, "ls-files", BASELINE)).toBe("");
    });
  },
  30_000,
);

// timeout: exercises five real ratchet checks in an isolated Git clone.
test.concurrent(
  "per-file shrink-only metrics follow Git-detected file moves",
  async () => {
    await withClone(async (root) => {
      const source = "apps/web/src/numeric-source.ts";
      const destination = "apps/web/src/moved/numeric-destination.ts";
      const numericCalls = (count: number) =>
        `${Array.from(
          { length: count },
          (_, index) =>
            `export const numeric${index} = Number(source${index});`,
        ).join("\n")}\n`;
      write({ root, relative: source, contents: numericCalls(20) });
      await commit(root, "add numeric fixture");
      const base = await git(root, "rev-parse", "HEAD");
      await git(root, "update-ref", "refs/remotes/origin/main", base);

      const reset = async () => {
        await git(root, "reset", "--hard", base);
        await git(root, "clean", "-fd");
      };
      const move = async (contents = numericCalls(20)) => {
        mkdirSync(path.dirname(path.join(root, destination)), {
          recursive: true,
        });
        await git(root, "mv", source, destination);
        write({ root, relative: destination, contents });
        await commit(root, "move numeric fixture");
        return await check(root);
      };

      expect((await move()).code).toBe(0);

      await reset();
      const increased = await move(numericCalls(21));
      expect(increased.code, increased.output).toBe(1);
      expect(increased.output).toContain(
        `raw-numeric-coercions (${destination}): actual increase 1`,
      );
      expect(increased.output).toContain(`${destination}: 20 -> 21`);

      await reset();
      expect((await move(numericCalls(19))).code).toBe(0);

      await reset();
      write({ root, relative: destination, contents: numericCalls(20) });
      await commit(root, "copy numeric fixture");
      const copied = await check(root);
      expect(copied.code, copied.output).toBe(1);
      expect(copied.output).toContain(
        `raw-numeric-coercions (${destination}): actual increase 20`,
      );

      await reset();
      const dissimilar = await move(
        "export const replacement = Number(replacement);\n",
      );
      expect(dissimilar.code, dissimilar.output).toBe(1);
      expect(dissimilar.output).toContain(
        `raw-numeric-coercions (${destination}): actual increase 1`,
      );
      expect(dissimilar.output).toContain(
        "edits below Git's similarity threshold are treated as a deletion plus an addition",
      );
    });
  },
  30_000,
);

test.concurrent(
  "the measured base overrides stale headroom and explicit merge-group bases",
  async () => {
    await withClone(async (root) => {
      const oldBase = await git(root, "rev-parse", "HEAD");
      write({ root, relative: FIRST, contents: casts(1) });
      write({
        root,
        relative: BASELINE,
        contents: '{"as-casts":{"files":{"apps/api/src/a.ts":100}}}\n',
      });
      await commit(root, "lower source with stale budget");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      write({ root, relative: FIRST, contents: casts(2) });
      const rejected = await run(root, [
        process.execPath,
        "scripts/ratchet.ts",
        "--check",
      ]);
      expect(rejected.code, rejected.output).toBe(1);
      expect(rejected.output).toContain("as-casts: 5 -> 6");
      expect(await ratchet(root, "--check", "--base", oldBase)).toContain(
        "ratchet --check: OK",
      );
      const badBase = await run(root, [
        process.execPath,
        "scripts/ratchet.ts",
        "--check",
        "--base",
        "absent-ref",
      ]);
      expect(badBase.code).not.toBe(0);
      expect(badBase.output).toContain("rev-parse failed");
    });
  },
  30_000,
);

test.concurrent.each([
  { label: "all-branch clone", branch: undefined },
  { label: "single-branch clone", branch: "feature-only" },
])(
  "--head refreshes main independently of the checkout ($label)",
  async ({ branch }) => {
    await withClone(
      async (root) => {
        if (branch !== undefined) {
          expect(
            await git(root, "config", "--get", "remote.origin.fetch"),
          ).toBe(`+refs/heads/${branch}:refs/remotes/origin/${branch}`);
        }
        const fork = await git(root, "rev-parse", "HEAD");
        const origin = await git(root, "remote", "get-url", "origin");
        write({ root: origin, relative: FIRST, contents: casts(1) });
        await commit(origin, "main improvement");
        await git(
          root,
          "fetch",
          "origin",
          "+refs/heads/main:refs/remotes/origin/main",
        );
        const main = await git(root, "rev-parse", "origin/main");
        await git(root, "checkout", "-b", "selected-head", main);
        write({ root, relative: FIRST, contents: casts(2) });
        await commit(root, "selected head increase");
        const head = await git(root, "rev-parse", "HEAD");
        await git(root, "checkout", "-b", "other-branch", fork);
        await git(root, "update-ref", "refs/remotes/origin/main", fork);

        expect((await check(root)).code).toBe(0);
        expect(await git(root, "rev-parse", "origin/main")).toBe(fork);
        for (const checkoutBranch of ["other-branch", "selected-head"]) {
          await git(root, "checkout", checkoutBranch);
          if (checkoutBranch === "selected-head") {
            await git(root, "update-ref", "-d", "refs/remotes/origin/main");
          }
          const checkout = await git(root, "rev-parse", "HEAD");
          const result = await check(root, "--head", head);
          expect(result.code, result.output).toBe(1);
          expect(result.output).toContain("as-casts: 5 -> 6");
          expect(result.output).toContain(`(${main})`);
          expect(await git(root, "rev-parse", "origin/main")).toBe(main);
          expect(await git(root, "rev-parse", "HEAD")).toBe(checkout);
        }

        await git(root, "checkout", "other-branch");
        write({ root, relative: FIRST, contents: casts(3) });
        const worktree = await check(root);
        expect(worktree.code, worktree.output).toBe(1);
        expect(worktree.output).toContain("as-casts: 6 -> 7");
        expect(worktree.output).toContain(`(${fork})`);
      },
      { branch, mutableOrigin: true },
    );
  },
  30_000,
);

test.concurrent(
  "--head measures a commit as data with that commit's allowances",
  async () => {
    await withClone(async (root) => {
      const base = await git(root, "rev-parse", "HEAD");
      await git(root, "checkout", "-b", "raise");
      write({ root, relative: FIRST, contents: casts(3) });
      // The head's own checker would pass anything; only the base's may run.
      write({
        root,
        relative: "scripts/ratchet.ts",
        contents: "process.exit(0);\n",
      });
      await commit(root, "raise with a permissive checker");
      const raised = await git(root, "rev-parse", "HEAD");
      await git(root, "checkout", "--quiet", base);
      const headCheck = async (head: string) =>
        await run(root, [
          process.execPath,
          "scripts/ratchet.ts",
          "--check",
          "--base",
          base,
          "--head",
          head,
        ]);
      const rejected = await headCheck(raised);
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
      expect((await headCheck(raised)).code).toBe(1);
      rmSync(path.join(root, allowancePath));
      await git(root, "checkout", "--quiet", "raise");
      write({ root, relative: allowancePath, contents: `${allowance}\n` });
      await commit(root, "fund the increase");
      const funded = await git(root, "rev-parse", "HEAD");
      await git(root, "checkout", "--quiet", base);
      const accepted = await headCheck(funded);
      expect(accepted.code, accepted.output).toBe(0);
      expect(accepted.output).toContain("ratchet --check: OK");
    });
  },
  30_000,
);

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

test.concurrent(
  "CI selects the merge base on PRs and the target-branch base on merge groups",
  async () => {
    expect(selectionStep["env"]).toMatchObject({
      MERGE_GROUP_BASE_SHA: `\${{ github.event_name == 'merge_group' && needs.ci-plan.outputs.target_base_sha || '' }}`,
      BASE_REF: `\${{ github.base_ref || 'main' }}`,
    });
    expect(policySteps.indexOf(selectionStep)).toBeLessThan(
      policySteps.indexOf(ratchetGuardStep),
    );
    await withClone(async (root) => {
      const base = await git(root, "rev-parse", "HEAD");
      write({ root, relative: FIRST, contents: casts(1) });
      await commit(root, "new main");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      const newBase = await git(root, "rev-parse", "HEAD");
      expect(newBase).not.toBe(base);
      for (const eventBase of ["", base]) {
        const output = path.join(root, "github-env");
        writeFileSync(output, "");
        const selected = await run(root, ["bash", "-c", selectionCommand], {
          GITHUB_ENV: output,
          MERGE_GROUP_BASE_SHA: eventBase,
          BASE_REF: "main",
        });
        expect(selected.code, selected.output).toBe(0);
        expect(readFileSync(output, "utf-8")).toBe(
          `RATCHET_BASE_REF=${eventBase || newBase}\n`,
        );
        const checked = await run(
          root,
          [process.execPath, "scripts/ratchet.ts", "--check"],
          { RATCHET_BASE_REF: eventBase || newBase },
        );
        expect(checked.code, checked.output).toBe(0);
        expect(checked.output).toContain(`(${eventBase || newBase})`);
      }
    });
  },
  30_000,
);

describe("ratchet command-line usage", () => {
  for (const flag of ["--help", "-h"]) {
    test.concurrent(`${flag} prints usage successfully`, async () => {
      const result = await run(ROOT, [
        process.execPath,
        "scripts/ratchet.ts",
        flag,
      ]);
      expect(result.code).toBe(0);
      expect(result.output).toContain("Usage: bun scripts/ratchet.ts");
      expect(result.output).toContain("--check");
      expect(result.output).toContain("scripts/ratchet-allowances/<slug>.json");
      expect(result.output).toContain('"delta": <positive integer>');
    });
  }

  for (const flag of ["--write", "-x"]) {
    test.concurrent(`${flag} prints usage and fails`, async () => {
      const result = await run(ROOT, [
        process.execPath,
        "scripts/ratchet.ts",
        flag,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain(`unsupported ratchet option: ${flag}`);
      expect(result.output).toContain("Usage: bun scripts/ratchet.ts");
    });
  }

  test.concurrent(
    "the supported self-test mode retains its behavior",
    async () => {
      const result = await run(ROOT, [
        process.execPath,
        "scripts/ratchet.ts",
        "--self-test",
      ]);
      expect(result.code).toBe(0);
      expect(result.output).toContain("ratchet --self-test: PASS");
    },
  );
});

test.concurrent(
  "the lint planner inherits only result-boundary debt measured in the base tree",
  async () => {
    await withClone(async (root) => {
      const legacy = "apps/api/src/lib/legacy.ts";
      const fresh = "apps/api/src/lib/fresh.ts";
      write({
        root,
        relative: legacy,
        contents: 'throw new Error("legacy");\n',
      });
      await commit(root, "base debt");
      const base = await git(root, "rev-parse", "HEAD");
      write({ root, relative: legacy, contents: "export const clean = 1;\n" });
      write({ root, relative: fresh, contents: 'throw new Error("fresh");\n' });
      const measured = await succeed(root, [
        process.execPath,
        "--eval",
        'import { measureResultBoundaryDebt } from "./scripts/ratchet"; console.log(JSON.stringify([...measureResultBoundaryDebt(process.argv.at(-1) ?? "")]));',
        base,
      ]);
      expect(JSON.parse(measured)).toEqual([legacy]);
    });
  },
  30_000,
);

const ALLOWANCE = "scripts/ratchet-allowances/fixture-increase.json";
const fund = (root: string, allowance: unknown, relative = ALLOWANCE) =>
  write({ root, relative, contents: `${JSON.stringify(allowance)}\n` });
const check = async (root: string, ...args: string[]) =>
  await run(root, [process.execPath, "scripts/ratchet.ts", "--check", ...args]);

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
  test.concurrent(
    name,
    async () => {
      await withClone(async (root) => {
        write({ root, relative: FIRST, contents: casts(count) });
        fund(root, {
          metric: "as-casts",
          delta,
          reason: "Required fixture conversion",
        });
        await commit(root, "change with allowance");
        const result = await check(root);
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

test.concurrent(
  "multiple added allowances must sum to the actual increase",
  async () => {
    await withClone(async (root) => {
      write({ root, relative: FIRST, contents: casts(4) });
      for (const slug of ["one", "two"]) {
        fund(
          root,
          { metric: "as-casts", delta: 1, reason: "Fixture conversion" },
          `scripts/ratchet-allowances/${slug}.json`,
        );
      }
      await commit(root, "split funding");
      expect((await check(root)).code).toBe(0);
    });
  },
  30_000,
);

test.concurrent(
  "allowance repair commands preserve each complete filename and JSON payload",
  async () => {
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
      await succeed(root, ["bash", "-euo", "pipefail", "-c", command]);
      expect(
        JSON.parse(readFileSync(path.join(root, target), "utf-8")),
      ).toEqual(template);
      expect(
        readdirSync(path.join(root, "scripts/ratchet-allowances")).toSorted(),
      ).toEqual([path.basename(target), path.basename(untouched)].toSorted());
      expect(readFileSync(path.join(root, untouched), "utf-8")).toBe(
        "unchanged bytes\n",
      );
      await succeed(root, [
        "bash",
        "-euo",
        "pipefail",
        "-c",
        allowanceRemovalCommand([target]),
      ]);
      expect(
        readdirSync(path.join(root, "scripts/ratchet-allowances")),
      ).toEqual([path.basename(untouched)]);
      expect(readFileSync(path.join(root, untouched), "utf-8")).toBe(
        "unchanged bytes\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.concurrent(
  "the adjustment command consolidates every added allowance for the metric",
  async () => {
    await withClone(async (root) => {
      write({ root, relative: FIRST, contents: casts(3) });
      const files = [
        "scripts/ratchet-allowances/one.json",
        "scripts/ratchet-allowances/two.json",
      ] as const;
      for (const file of files) {
        fund(root, { metric: "as-casts", delta: 1, reason: "Fixture" }, file);
      }
      await commit(root, "split excess funding");
      const result = await check(root);
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
      await succeed(root, ["bash", "-euo", "pipefail", "-c", command]);
      await commit(root, "consolidate funding");
      const adjusted = await check(root);
      expect(adjusted.code, adjusted.output).toBe(0);
    });
  },
  30_000,
);

test.concurrent(
  "an unmerged main improvement cannot change the PR funding requirement",
  async () => {
    await withClone(async (root) => {
      const fork = await git(root, "rev-parse", "HEAD");
      await git(root, "checkout", "-b", "advance-main");
      write({ root, relative: FIRST, contents: casts(1) });
      await commit(root, "main improvement after fork");
      const main = await git(root, "rev-parse", "HEAD");
      await git(root, "update-ref", "refs/remotes/origin/main", main);
      await git(root, "checkout", "-b", "feature", fork);
      write({ root, relative: FIRST, contents: casts(3) });
      fund(root, {
        metric: "as-casts",
        delta: 1,
        reason: "Fixture conversion",
      });
      await commit(root, "fund branch increase relative to fork");
      expect(await git(root, "merge-base", "origin/main", "HEAD")).toBe(fork);
      expect(main).not.toBe(fork);
      const result = await check(root);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("ratchet --check: OK");
      const againstTip = await check(root, "--base", main);
      expect(againstTip.code, againstTip.output).toBe(1);
      expect(againstTip.output).toContain("actual increase 2, funded 1");
    });
  },
  30_000,
);

test.concurrent(
  "working tree allowance edits cannot fund a committed increase",
  async () => {
    await withClone(async (root) => {
      write({ root, relative: FIRST, contents: casts(4) });
      fund(root, {
        metric: "as-casts",
        delta: 1,
        reason: "Fixture conversion",
      });
      await commit(root, "commit insufficient funding");
      fund(root, {
        metric: "as-casts",
        delta: 2,
        reason: "Uncommitted correction",
      });
      const result = await check(root);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain("actual increase 2, funded 1");
      expect(result.output).toContain(ALLOWANCE);
    });
  },
  30_000,
);

test.concurrent(
  "base allowances stay inert even when edited; counting them kills the guard",
  async () => {
    await withClone(async (root) => {
      fund(root, {
        metric: "as-casts",
        delta: 1,
        reason: "Historical conversion",
      });
      await commit(root, "historical allowance");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      write({ root, relative: FIRST, contents: casts(3) });
      fund(root, {
        metric: "as-casts",
        delta: 1,
        reason: "Edited historical reason",
      });
      await commit(root, "later increase");
      const result = await check(root);
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
      expect((await check(root)).code).toBe(0);
    });
  },
  30_000,
);

test.concurrent(
  "pruning an allowance inherited from the base passes",
  async () => {
    await withClone(async (root) => {
      fund(root, {
        metric: "as-casts",
        delta: 1,
        reason: "Historical conversion",
      });
      await commit(root, "historical allowance");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      rmSync(path.join(root, ALLOWANCE));
      await commit(root, "prune historical allowance");
      expect((await check(root)).code).toBe(0);
    });
  },
  30_000,
);

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
  test.concurrent(
    name,
    async () => {
      await withClone(async (root) => {
        fund(root, allowance);
        await commit(root, "invalid allowance");
        const result = await check(root);
        expect(result.code, result.output).toBe(1);
        expect(result.output).toContain(diagnostic);
        expect(result.output).toContain(ALLOWANCE);
      });
    },
    30_000,
  );
}

test.concurrent(
  "per-file funding cannot move to another file even when the total is unchanged",
  async () => {
    await withClone(async (root) => {
      const oldFile = "apps/api/src/old.ts";
      const newFile = "apps/api/src/new.ts";
      const occurrence = 'import { rootDb } from "@/db/root";\n';
      write({ root, relative: oldFile, contents: occurrence });
      await commit(root, "base per-file occurrence");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      write({ root, relative: oldFile, contents: "" });
      write({ root, relative: newFile, contents: occurrence });
      fund(root, {
        metric: "direct-root-connection-imports",
        file: oldFile,
        delta: 1,
        reason: "Fixture move",
      });
      await commit(root, "fund wrong file");
      const rejected = await check(root);
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
      await commit(root, "fund destination file");
      const accepted = await check(root);
      expect(accepted.code, accepted.output).toBe(0);
    });
  },
  30_000,
);

test.concurrent(
  "merge-group base_sha funds only allowances absent from that event base",
  async () => {
    await withClone(async (root) => {
      const eventBase = await git(root, "rev-parse", "HEAD");
      fund(root, {
        metric: "as-casts",
        delta: 1,
        reason: "Fixture conversion",
      });
      await commit(root, "main allowance");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      write({ root, relative: FIRST, contents: casts(3) });
      await commit(root, "merge group increase");
      const selected = await run(root, ["bash", "-c", selectionCommand], {
        GITHUB_ENV: path.join(root, "github-env"),
        MERGE_GROUP_BASE_SHA: eventBase,
      });
      expect(selected.code, selected.output).toBe(0);
      const selectedBase = readFileSync(path.join(root, "github-env"), "utf-8")
        .trim()
        .split("=")
        .at(1);
      expect(selectedBase).toBe(eventBase);
      const accepted = await check(root, "--base", selectedBase ?? "");
      expect(accepted.code, accepted.output).toBe(0);
      const inherited = await check(root);
      expect(inherited.code, inherited.output).toBe(1);
      expect(inherited.output).toContain("actual increase 1, funded 0");
    });
  },
  30_000,
);

for (const allowanceChange of ["added", "changed"] as const) {
  test.concurrent(
    `an allowance ${allowanceChange} for paint transitions can accompany its utility without invalidating the base`,
    async () => {
      await withClone(async (root) => {
        const relative =
          allowanceChange === "added"
            ? "packages/ui/src/components/paint-control.ts"
            : "packages/ui/src/components/input-control.ts";
        write({
          root,
          relative,
          contents: 'export const style = "transition-opacity";\n',
        });
        await commit(root, "base control without paint utility");
        await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
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
        await commit(root, "allow the control paint utility");
        const accepted = await check(root);
        expect(accepted.code, accepted.output).toBe(0);
        expect(accepted.output).toContain("ratchet --check: OK");

        // Restoring head-only consistency checking on base must reject this PR.
        const mutant = updated.replace(
          'allowed === 0 && role === "head"',
          "allowed === 0",
        );
        expect(mutant).not.toBe(updated);
        writeFileSync(script, mutant);
        const rejectedBase = await check(root);
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
        const rejectedHead = await check(root);
        expect(rejectedHead.code, rejectedHead.output).not.toBe(0);
        expect(rejectedHead.output).toContain(
          `allowance for ${relative} no longer matches`,
        );
      });
    },
    30_000,
  );
}

test.concurrent(
  "the base may predate a required domain action definition but head may not lose it",
  async () => {
    await withClone(async (root) => {
      const relative = "apps/api/scripts/lib/capability-catalog.ts";
      write({
        root,
        relative,
        contents: 'export const unrelated = "fixture";\n',
      });
      await commit(root, "base before domain actions");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      write({
        root,
        relative,
        contents: 'export const DOMAIN_ACTION_VERBS = ["create"] as const;\n',
      });
      await commit(root, "define domain actions");
      const accepted = await check(root);
      expect(accepted.code, accepted.output).toBe(0);
      const script = path.join(root, "scripts/ratchet.ts");
      const original = readFileSync(script, "utf-8");
      const mutant = original.replace(
        'if (role === "base") {\n      return 0;\n    }',
        "",
      );
      expect(mutant).not.toBe(original);
      writeFileSync(script, mutant);
      const rejectedBase = await check(root);
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
      const rejected = await check(root);
      expect(rejected.code, rejected.output).not.toBe(0);
      expect(rejected.output).toContain(
        "capability-domain-action-verbs: DOMAIN_ACTION_VERBS not found",
      );
    });
  },
  30_000,
);

// Measured p95: 10.2 s; this must run the ratchet repeatedly in a real Git clone.
test.concurrent(
  "untracked files cannot increase file, duplication, directory or dependency metrics",
  async () => {
    await withClone(async (root) => {
      const libFile = "apps/api/src/lib/domain/helper.ts";
      const helper = `export const duplicateHelperBinding = () => { ${Array.from(
        { length: 25 },
        (_, index) => `const value${index} = source${index} + ${index};`,
      ).join(" ")} };\n`;
      write({ root, relative: libFile, contents: helper });
      await commit(root, "tracked helper");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
      const before = await check(root);
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
      const after = await check(root);
      const report = await ratchet(root);
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
      const rejected = await check(root);
      expect(rejected.code, rejected.output).toBe(1);
      expect(rejected.output).toContain("as-casts: 6 -> 16");
      expect(rejected.output).toContain("cross-app-lib-path-copies");
      expect(rejected.output).toContain("duplicate-token-blocks");
      expect(rejected.output).toContain(
        "cross-workspace-duplicate-export-names",
      );
      expect(rejected.output).toContain("api-lib-top-level-entries");
      expect(rejected.output).toContain("direct-third-party-declarations");
      writeFileSync(script, original);
      // Staged additions belong to the head scan, and local tracked edits remain visible.
      await git(root, "add", "apps/api/src/untracked.ts");
      const staged = await check(root);
      expect(staged.code, staged.output).toBe(1);
      expect(staged.output).toContain("as-casts: 6 -> 16");
    });
  },
  25_000,
);

test.concurrent(
  "malformed ledger and dependency schemas fail in both measurement roles",
  async () => {
    await withClone(async (root) => {
      for (const { relative, contents, diagnostic } of [
        {
          relative: "scripts/instruction-enforcement-ledger.json",
          contents: "[]",
          diagnostic:
            "instruction-enforcement ledger must hold reviewOnlyRules",
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
  },
  30_000,
);

test.concurrent(
  "the full counter self-test exercises both file and repository measurement contracts",
  async () => {
    await withClone(async (root) => {
      expect(await ratchet(root, "--self-test")).toContain(
        "ratchet --self-test: PASS",
      );
    });
  },
  30_000,
);

test.concurrent(
  "staged removal excludes untracked root manifests and lockfiles from all modes",
  async () => {
    await withClone(async (root) => {
      await git(root, "rm", "--cached", "package.json", "bun.lock");
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
      const result = await check(root);
      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain(
        "lockfile-package-entries: 0 (report only)",
      );
      const report = await ratchet(root);
      expect(report).toMatch(
        /direct-third-party-declarations\s+0\s+\(baseline 0, 0\)/u,
      );
      expect(report).toContain("lockfile-package-entries: 0 (report only)");
    });
  },
  30_000,
);

test.concurrent(
  "lifecycle ratchets reject allowances for direct writes and unmanaged specs",
  async () => {
    await withClone(async (root) => {
      const specs = "apps/api/src/lib/db/transition-specs.ts";
      write({
        root,
        relative: specs,
        contents: "export const TRANSITIONS = {};\n",
      });
      await commit(root, "managed fixture base");
      await git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
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
      await commit(root, "attempt lifecycle allowances");
      const rejected = await check(root);
      expect(rejected.code, rejected.output).toBe(1);
      expect(rejected.output).toContain(
        "shrink-only metric takes no allowances direct-status-writes",
      );
      expect(rejected.output).toContain(
        "shrink-only metric takes no allowances unmanaged-transition-specs",
      );
    });
  },
  30_000,
);
