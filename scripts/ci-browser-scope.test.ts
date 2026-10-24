import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  browserSuiteInputs,
  ciBrowserScopePredicate,
  requiresCiBrowser,
} from "./ci-browser-scope";
import {
  sourceClosureProblems,
  unresolvedRuntimeImports,
} from "./docker-source-closure";
import { GENERATORS } from "./generated-files";
import { lexShell } from "./install-free-ci";

const ROOT = path.resolve(import.meta.dirname, "..");
const source = readFileSync(
  path.join(ROOT, ".github/workflows/ci.yml"),
  "utf-8",
);
const workflow = v.parse(
  v.object({
    jobs: v.object({
      "ci-browser": v.object({
        steps: v.array(
          v.looseObject({
            name: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(source),
);

// Vite serves the frontend roots and their imported shared modules; no API
// process is started by these configs. Include test sources and config imports.
const frontendRoots = [
  "apps/desktop/src/mainview/",
  "apps/web/src/",
  "apps/extension/src/",
  "packages/ui/src/",
];
const configFiles = [
  "apps/desktop/playwright.config.ts",
  "apps/desktop/vite.config.ts",
  "apps/web/vite.config.ts",
  "apps/web/e2e/playwright.ui-playground.config.ts",
  "apps/extension/playwright.config.ts",
  "packages/ui/playwright.config.ts",
  "packages/ui/vite.config.ts",
];

test("analytics imports stay independent of generated web route projections", () => {
  const inventory = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  expect(inventory.exitCode).toBe(0);
  const files = inventory.stdout.toString().split("\0").filter(Boolean);
  const tree = new Map(files.map((file) => [`/app/${file}`, file]));
  const routeTree = GENERATORS.find(({ id }) => id === "route-tree");
  expect(routeTree).toBeDefined();
  for (const output of routeTree?.outputs ?? []) {
    tree.set(`/app/${output}`, output);
  }
  const seen = new Set<string>();
  expect(
    sourceClosureProblems(
      ROOT,
      tree,
      [
        "/app/apps/web/src/lib/analytics/provider.tsx",
        "/app/apps/web/src/lib/analytics/posthog.ts",
      ],
      seen,
    ),
  ).toEqual([]);
  expect(seen.size).toBeGreaterThan(0);
  for (const output of routeTree?.outputs ?? []) {
    expect(seen.has(`/app/${output}`), output).toBe(false);
  }
});

test("browser scope skips unrelated API implementation and preserves every served runtime dependency", () => {
  expect(
    requiresCiBrowser({
      root: ROOT,
      changed: ["apps/api/src/handlers/health.ts"],
    }),
  ).toBe(false);
  const inventory = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  expect(inventory.exitCode).toBe(0);
  const files = inventory.stdout.toString().split("\0").filter(Boolean);
  const tree = new Map(files.map((file) => [`/app/${file}`, file]));
  // Vite starts after this producer restores every declared route projection.
  const routeTree = GENERATORS.find(({ id }) => id === "route-tree");
  expect(routeTree).toBeDefined();
  for (const output of routeTree?.outputs ?? []) {
    tree.set(`/app/${output}`, output);
  }
  const entries = files.filter(
    (file) =>
      /\.[cm]?[jt]sx?$/u.test(file) &&
      (frontendRoots.some((root) => file.startsWith(root)) ||
        configFiles.includes(file) ||
        file.startsWith("apps/desktop/tests/browser/") ||
        file.startsWith("apps/web/e2e/ui-playground/") ||
        file.startsWith("apps/extension/tests/")),
  );
  const seen = new Set<string>();
  const problems = sourceClosureProblems(
    ROOT,
    tree,
    entries.map((file) => `/app/${file}`),
    seen,
  );
  expect(entries.length).toBeGreaterThan(0);
  expect(problems).toEqual([]);
  const required = ciBrowserScopePredicate({ root: ROOT });
  for (const input of routeTree?.inputs ?? []) {
    expect(
      required([input.split("*").at(0)?.replace(/\/$/u, "") ?? input]),
      input,
    ).toBe(true);
  }
  const consumed = [...seen]
    .map((file) => file.slice("/app/".length))
    .filter((file) => tree.has(`/app/${file}`));
  const included = new Set(consumed.filter((file) => required([file])));
  const omissions = (selection: ReadonlySet<string>) =>
    consumed.filter((file) => !selection.has(file));
  expect(omissions(included)).toEqual([]);
  for (const file of consumed) {
    const omitted = new Set(included);
    omitted.delete(file);
    expect(omissions(omitted), file).toEqual([file]);
  }
}, 30_000);

test("browser admission follows every declared suite selector and preparation input", () => {
  const inputs = browserSuiteInputs(source);
  const expected = new Set<string>();
  for (const { run } of workflow.jobs["ci-browser"].steps) {
    if (run === undefined) {
      continue;
    }
    for (const event of lexShell(run)) {
      if (event.type !== "command" || !event.words.includes("--quiet")) {
        continue;
      }
      const boundary = event.words.indexOf("--");
      if (boundary !== -1) {
        for (const file of event.words.slice(boundary + 1)) {
          expected.add(file);
        }
      }
    }
  }
  expect(expected.size).toBeGreaterThan(0);
  for (const input of expected) {
    expect(inputs, input).toContain(input);
    expect(requiresCiBrowser({ root: ROOT, changed: [input] }), input).toBe(
      true,
    );
  }
  for (const file of ["apps/api/.env.example", "apps/web/.env.example"]) {
    expect(inputs, file).toContain(file);
    expect(requiresCiBrowser({ root: ROOT, changed: [file] }), file).toBe(true);
  }
});

test("unresolvable browser selectors retain coverage", () => {
  expect(() => browserSuiteInputs("jobs: {}")).toThrow(
    "Missing browser suite steps",
  );
  const invalid = source.replace(
    "            apps/web \\",
    "            $UNKNOWN_INPUT \\",
  );
  expect(invalid).not.toBe(source);
  expect(() => browserSuiteInputs(invalid)).toThrow(
    "Browser scope requires literal Git paths",
  );
  expect(
    requiresCiBrowser({
      root: path.join(ROOT, "missing-checkout"),
      changed: ["apps/api/src/handlers/health.ts"],
    }),
  ).toBe(true);
});

test("the shared import reader identifies dependencies that need conservative discovery", () => {
  expect(unresolvedRuntimeImports("input.ts", 'import("./fixed.ts");')).toEqual(
    [],
  );
  expect(
    unresolvedRuntimeImports("input.ts", "import(variable);"),
  ).toHaveLength(1);
});

test("browser source consumption preserves an independently pinned alias chain", () => {
  const root = mkdtempSync(path.join(tmpdir(), "browser-alias-scope-"));
  const entry = "apps/web/src/alias-entry.ts";
  const dependency = "packages/browser-scope-fixture/src/dependency.ts";
  const transitive = "packages/browser-scope-fixture/src/transitive.ts";
  const expected = [entry, dependency, transitive];
  const files = {
    ".github/workflows/ci.yml": source,
    "bun.lock": readFileSync(path.join(ROOT, "bun.lock"), "utf-8"),
    "turbo.json": readFileSync(path.join(ROOT, "turbo.json"), "utf-8"),
    "apps/web/tsconfig.json": JSON.stringify({
      compilerOptions: {
        paths: { "@fixture/*": ["../../packages/browser-scope-fixture/src/*"] },
      },
    }),
    [entry]: 'import "@fixture/dependency";',
    [dependency]: 'import "./transitive";',
    [transitive]: "export const value = 1;",
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    }
    const tree = new Map(
      Object.keys(files).map((file) => [`/app/${file}`, file]),
    );
    const seen = new Set<string>();
    expect(sourceClosureProblems(root, tree, [`/app/${entry}`], seen)).toEqual(
      [],
    );
    expect(seen).toEqual(new Set(expected.map((file) => `/app/${file}`)));
    const required = ciBrowserScopePredicate({ root });
    for (const file of expected) {
      expect(required([file]), file).toBe(true);
    }
    expect(required(["apps/api/src/handlers/health.ts"])).toBe(false);
    const missingPackageScope = source.replace("            packages \\", "");
    expect(missingPackageScope).not.toBe(source);
    writeFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      missingPackageScope,
    );
    const narrowed = ciBrowserScopePredicate({ root });
    expect(narrowed([dependency])).toBe(false);
    expect(narrowed([transitive])).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The UI and extension scope steps decide in their own shell bodies; run
// those exact bodies against a scratch history whose only change is the probe.
const scopeStep = (name: string) => {
  const step = workflow.jobs["ci-browser"].steps.find(
    (candidate) => candidate.name === name,
  );
  if (step?.run === undefined) {
    throw new Error(`Missing browser scope step: ${name}`);
  }
  return step.run;
};

const PATHSPEC_START = "HEAD -- \\\n";

const declaredPathspecs = (run: string) => {
  const start = run.indexOf(PATHSPEC_START);
  const end = run.indexOf("; then", start);
  if (start === -1 || end === -1) {
    throw new Error("Browser scope step has no declared pathspecs");
  }
  return run
    .slice(start + PATHSPEC_START.length, end)
    .split("\\\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const scrubbedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

type ScopeRun = {
  changed?: string;
  event?: string;
  heavyOnly?: string;
  withBase?: boolean;
};

const emittedScope = (run: string, options: ScopeRun) => {
  const repository = mkdtempSync(path.join(tmpdir(), "browser-scope-"));
  const vcs = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repository,
      env: {
        ...scrubbedEnvironment,
        GIT_AUTHOR_NAME: "probe",
        GIT_AUTHOR_EMAIL: "probe@example.invalid",
        GIT_COMMITTER_NAME: "probe",
        GIT_COMMITTER_EMAIL: "probe@example.invalid",
      },
    });
    if (result.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    }
  };
  try {
    vcs("init", "-q", "-b", "main");
    writeFileSync(path.join(repository, "base.txt"), "base\n");
    vcs("add", ".");
    vcs("commit", "-q", "--no-gpg-sign", "-m", "base");
    if (options.withBase !== false) {
      vcs("update-ref", "refs/remotes/origin/main", "HEAD");
    }
    if (options.changed !== undefined) {
      const file = path.join(repository, options.changed);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "probe\n");
      vcs("add", ".");
      vcs("commit", "-q", "--no-gpg-sign", "-m", "probe");
    }
    const output = path.join(repository, ".github-output");
    writeFileSync(output, "");
    const result = Bun.spawnSync(["bash", "-e", "-o", "pipefail", "-c", run], {
      cwd: repository,
      env: {
        ...scrubbedEnvironment,
        GITHUB_OUTPUT: output,
        BASE_REF: "main",
        EVENT_NAME: options.event ?? "merge_group",
        HEAVY_ONLY: options.heavyOnly ?? "false",
      },
      stderr: "ignore",
    });
    if (result.exitCode !== 0) {
      throw new Error(`Browser scope step exited ${String(result.exitCode)}`);
    }
    const emitted = readFileSync(output, "utf-8").trim();
    if (emitted === "required=true") {
      return true;
    }
    return emitted === "required=false" ? false : emitted;
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
};

const ROOT_FILES = new Set([
  "bunfig.toml",
  ".npmrc",
  "VERSION",
  "bun.lock",
  "package.json",
]);

// A pathspec naming a file is changed itself; a directory gets a file inside.
const probeFor = (pathspec: string) =>
  /\.[a-z]+$/u.test(path.basename(pathspec)) ||
  ROOT_FILES.has(path.basename(pathspec))
    ? pathspec
    : `${pathspec}/browser-scope-probe.txt`;

const scopeProofViolations = (run: string) => {
  const violations: string[] = [];
  const check = (label: string, actual: unknown, wanted: boolean) => {
    if (actual !== wanted) {
      violations.push(`${label}: emitted ${String(actual)}`);
    }
  };
  for (const pathspec of declaredPathspecs(run)) {
    check(pathspec, emittedScope(run, { changed: probeFor(pathspec) }), true);
  }
  check(
    "unrelated change",
    emittedScope(run, { changed: "docs/unrelated-probe.md" }),
    false,
  );
  check("manual run", emittedScope(run, { event: "workflow_dispatch" }), true);
  check("heavy run", emittedScope(run, { heavyOnly: "true" }), true);
  check(
    "unreadable base",
    emittedScope(run, { changed: "docs/unrelated-probe.md", withBase: false }),
    true,
  );
  return violations;
};

for (const name of [
  "Check UI browser test scope",
  "Check extension browser test scope",
]) {
  test(`${name} emits its declared selection and fails open`, () => {
    const run = scopeStep(name);
    expect(declaredPathspecs(run).length).toBeGreaterThan(3);
    expect(scopeProofViolations(run)).toEqual([]);
  }, 60_000);
}

test("the emitted-scope proof rejects constant emitters", () => {
  const run = scopeStep("Check extension browser test scope");
  const selector = run.slice(
    run.indexOf("HEAD -- "),
    run.indexOf("; then") + "; then".length,
  );
  for (const constant of ["false", "true"]) {
    const planted = `if false && git diff --quiet origin/main...${selector}\n  :\nfi\necho "required=${constant}" >> "$GITHUB_OUTPUT"`;
    expect(declaredPathspecs(planted)).toEqual(declaredPathspecs(run));
    expect(scopeProofViolations(planted).length, constant).toBeGreaterThan(0);
  }
}, 60_000);

// Measured p95 is 18.3 s; this test must run the real planner for both scope values.
test("the desktop browser scope passes through the plan's emitted value", () => {
  const run = scopeStep("Check desktop browser test scope");
  for (const required of ["true", "false"]) {
    const directory = mkdtempSync(path.join(tmpdir(), "desktop-scope-"));
    const output = path.join(directory, "out");
    try {
      writeFileSync(output, "");
      const result = Bun.spawnSync(["bash", "-e", "-c", run], {
        env: {
          ...scrubbedEnvironment,
          GITHUB_OUTPUT: output,
          REQUIRED: required,
        },
      });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(output, "utf-8").trim()).toBe(`required=${required}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  const plan = (file: string) =>
    Bun.spawnSync(
      ["bun", "scripts/ci-package-scope.ts", "--desktop-browser", file],
      { cwd: ROOT, env: scrubbedEnvironment, stderr: "ignore" },
    )
      .stdout.toString()
      .trim();
  expect(plan("apps/desktop/src/mainview/browser-scope-probe.ts")).toBe("true");
  expect(plan("docs/unrelated-probe.md")).toBe("false");
  // scripts/ci-plan-scope.test.ts covers the planner's wiring: the detector
  // reads the dependency-classified list and fails closed.
}, 40_000);
