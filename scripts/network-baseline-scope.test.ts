import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { isCanonicalFailureCancellation } from "./ci-cancellation-contract";
import {
  prepareComparisonBaseline,
  validateBaselineFile,
} from "./network-baseline-scope";

const githubExpression = (value: string) => ["$", "{{ ", value, " }}"].join("");

const entry = (depth: number) => ({ depth, requests: [`GET /${depth}`] });

const routeTree = `
import { Route as rootRouteImport } from './routes/__root'
import { Route as IndexRouteImport } from './routes/index'
import { Route as ProtectedRouteImport } from './routes/_protected'
import { Route as ChatRouteRouteImport } from './routes/_protected.chat/route'
import { Route as ChatRouteImport } from './routes/_protected.chat/index'
import { Route as SettingsRouteImport } from './routes/_protected.settings/index'
declare module '@tanstack/react-router' {
  interface FileRoutesByPath {
    '/': {
      id: '/'
      path: '/'
      fullPath: '/'
      preLoaderRoute: typeof IndexRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/_protected': {
      id: '/_protected'
      path: ''
      fullPath: '/'
      preLoaderRoute: typeof ProtectedRouteImport
      parentRoute: typeof rootRouteImport
    }
    '/_protected/chat': {
      id: '/_protected/chat'
      path: '/chat'
      fullPath: '/chat'
      preLoaderRoute: typeof ChatRouteRouteImport
      parentRoute: typeof ProtectedRoute
    }
    '/_protected/chat/': {
      id: '/_protected/chat/'
      path: '/'
      fullPath: '/chat/'
      preLoaderRoute: typeof ChatRouteImport
      parentRoute: typeof ChatRouteRoute
    }
    '/settings': {
      id: '/settings'
      path: '/settings'
      fullPath: '/settings'
      preLoaderRoute: typeof SettingsRouteImport
      parentRoute: typeof ProtectedRoute
    }
  }
}`;

describe("network baseline scope", () => {
  const scopedRoutes = (changedPaths: string[], tree = routeTree) =>
    prepareComparisonBaseline({
      base: {},
      changedPaths,
      baseRouteTree: routeTree,
      routeTree: tree,
      declarations: [],
    }).changedRoutes;

  test("index route changes include their redirect target and leave unrelated routes strict", () => {
    expect(
      scopedRoutes(["apps/web/src/routes/_protected.chat/index.tsx"]),
    ).toEqual(["/chat", "/chat target"]);
  });

  test("pathless layout changes scope its route and descendants", () => {
    expect(scopedRoutes(["apps/web/src/routes/_protected.tsx"])).toEqual([
      "/",
      "/ target",
      "/chat",
      "/chat target",
      "/settings",
      "/settings target",
    ]);
  });

  test("deleted routes remain scoped from the base tree", () => {
    const tree = routeTree.replace(
      / {4}'\/_protected\/chat\/': \{[\s\S]*?^ {4}\}\n/gmu,
      "",
    );
    expect(tree).not.toBe(routeTree);
    expect(
      scopedRoutes(["apps/web/src/routes/_protected.chat/index.tsx"], tree),
    ).toEqual(["/chat", "/chat target"]);
  });

  test("root changes include every route and an unrelated source includes none", () => {
    expect(scopedRoutes(["apps/web/src/routes/__root.tsx"])).toEqual([
      "/",
      "/ target",
      "/chat",
      "/chat target",
      "/settings",
      "/settings target",
    ]);
    expect(scopedRoutes(["apps/web/src/component.tsx"])).toEqual([]);
  });

  test("rejects a budget for a request the route does not record", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "network-baseline-"));
    try {
      for (const field of ["requestCounts", "dbQueries", "responseSizes"]) {
        const file = path.join(directory, `${field}.json`);
        writeFileSync(
          file,
          JSON.stringify({ "/": { ...entry(1), [field]: { "GET /gone": 1 } } }),
        );
        const result = Bun.spawnSync([
          "bun",
          "scripts/network-baseline-scope.ts",
          "validate",
          file,
        ]);
        expect(result.exitCode, field).toBe(1);
        writeFileSync(
          file,
          JSON.stringify({ "/": { ...entry(1), [field]: { "GET /1": 1 } } }),
        );
        expect(validateBaselineFile(file)["/"]?.requests).toEqual(["GET /1"]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("validates schema and rejects oversized files and symlinks", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "network-baseline-"));
    const validPath = path.join(directory, "baseline.json");
    const oversizedPath = path.join(directory, "oversized.json");
    const symlinkPath = path.join(directory, "linked.json");
    try {
      writeFileSync(validPath, JSON.stringify({ "/": entry(1) }));
      expect(validateBaselineFile(validPath)).toEqual({ "/": entry(1) });
      writeFileSync(oversizedPath, " ".repeat(5 * 1024 * 1024 + 1));
      symlinkSync(validPath, symlinkPath);
      for (const { file, message } of [
        { file: oversizedPath, message: "exceeds" },
        { file: symlinkPath, message: "must not be a symlink" },
      ]) {
        const result = Bun.spawnSync([
          "bun",
          "scripts/network-baseline-scope.ts",
          "validate",
          file,
        ]);
        expect(result.exitCode).toBe(1);
        expect(result.stderr.toString()).toContain(message);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

// Recorder and publisher share a read-only, main-only authority boundary.
type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  permissions?: unknown;
  outputs?: Record<string, string>;
  steps: readonly {
    id?: string;
    name?: string;
    if?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  }[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isWorkflowJobs = (value: unknown): value is Record<string, WorkflowJob> =>
  isRecord(value) &&
  Object.values(value).every(
    (job) => isRecord(job) && Array.isArray(job["steps"]),
  );

const workflowSource = (file: string): string =>
  readFileSync(
    path.join(import.meta.dirname, "..", ".github", "workflows", file),
    "utf-8",
  );

const readWorkflowJobs = (file: string): Record<string, WorkflowJob> => {
  const parsed: unknown = Bun.YAML.parse(workflowSource(file));
  const jobs = isRecord(parsed) ? parsed["jobs"] : undefined;
  if (!isRecord(jobs)) {
    return expect.unreachable(`${file} has no jobs`);
  }
  // Reusable-workflow calls (`uses:` jobs) have no steps to inspect.
  const stepJobs = Object.fromEntries(
    Object.entries(jobs).filter(
      ([, job]) => isRecord(job) && Array.isArray(job["steps"]),
    ),
  );
  return isWorkflowJobs(stepJobs)
    ? stepJobs
    : expect.unreachable(`${file} has malformed jobs`);
};

describe("network baseline workflows", () => {
  test("preparation generates revision trees instead of reading a committed route tree", () => {
    const script = readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        ".github/actions/prepare-network-baseline/prepare.sh",
      ),
      "utf-8",
    );
    expect(script).not.toMatch(/git\s+show[^\n]*routeTree\.gen\.ts/u);
    expect(script).not.toContain("apps/web/src/routeTree.gen.ts");
    expect(script).toContain(
      'network-baseline-route-tree.ts "$repository" "$since" "$base_tree"',
    );
    expect(script).toContain(
      'network-baseline-route-tree.ts "$repository" "$head" "$head_tree"',
    );
    for (const file of ["ci.yml", "network-baseline-record.yml"]) {
      for (const job of Object.values(readWorkflowJobs(file))) {
        const prepare = job.steps.findIndex(
          (step) => step.uses === "./.github/actions/prepare-network-baseline",
        );
        if (prepare === -1) {
          continue;
        }
        const install = job.steps.findIndex(
          (step) => step.name === "Install dependencies",
        );
        expect(install, file).toBeGreaterThan(-1);
        expect(prepare, file).toBeGreaterThan(install);
      }
    }
  });

  test("recordings run only on main and carry an immutable source identity", () => {
    const source = workflowSource("network-baseline-record.yml");
    const parsed: unknown = Bun.YAML.parse(source);
    expect(isRecord(parsed) && parsed["on"]).toMatchObject({
      schedule: [{ cron: "17 2 * * *" }],
      workflow_dispatch: {},
    });
    if (!isRecord(parsed) || !isRecord(parsed["on"])) {
      expect.unreachable("workflow triggers");
    }
    expect(parsed["on"]["pull_request_target"]).toBeUndefined();
    expect(parsed["on"]["pull_request"]).toBeUndefined();
    expect(parsed["on"]["push"]).toBeUndefined();
    const jobs = readWorkflowJobs("network-baseline-record.yml");
    expect(jobs["build"]?.if).toContain("github.ref == 'refs/heads/main'");
    expect(jobs["record"]?.needs).toBe("build");
    expect(jobs["build"]?.permissions).toEqual({ contents: "read" });
    expect(jobs["record"]?.permissions).toEqual({
      contents: "read",
      actions: "read",
    });
    const record = jobs["record"] ?? expect.unreachable("record job");
    const seed = record.steps.findIndex(
      (step) => step.uses === "./.github/actions/prepare-network-baseline",
    );
    expect(seed).toBeGreaterThan(-1);
    expect(record.steps.at(seed)).toMatchObject({
      if: "(inputs.mode || 'write') == 'write'",
      with: {
        "base-sha": githubExpression("github.sha"),
        token: githubExpression("github.token"),
        purpose: "recording",
      },
    });
    expect(
      record.steps.findIndex((step) => step.env?.["E2E_NETWORK_BASELINE"]),
    ).toBeGreaterThan(seed);
    expect(source).toContain(
      `network-baseline-record-${githubExpression("github.sha")}`,
    );
    expect(source).toContain(
      `E2E_NETWORK_BASELINE: ${githubExpression("inputs.mode || 'write'")}`,
    );
    expect(source).not.toMatch(/\bsecrets\.\w/u);
    for (const job of Object.values(jobs)) {
      for (const step of job.steps) {
        if (step.uses?.startsWith("actions/checkout@")) {
          expect(step.with?.["persist-credentials"]).toBe(false);
          expect(step.with?.["ref"]).toBe(githubExpression("github.sha"));
        }
      }
    }
  });

  test("delivery validates successful main recordings with no branch write authority", () => {
    const source = workflowSource("network-baseline-deliver.yml");
    const jobs = readWorkflowJobs("network-baseline-deliver.yml");
    expect(Object.keys(jobs)).toEqual(["deliver"]);
    const deliver = jobs["deliver"] ?? expect.unreachable("delivery job");
    const parsed: unknown = Bun.YAML.parse(source);
    expect(isRecord(parsed) && parsed["on"]).toEqual({ workflow_call: null });
    expect(deliver.if).toContain("github.ref == 'refs/heads/main'");
    expect(deliver.if).toContain(
      "github.workflow_ref == format('{0}/.github/workflows/network-baseline-record.yml@refs/heads/main', github.repository)",
    );
    expect(deliver.if).toContain(
      `contains(fromJSON('["schedule", "workflow_dispatch"]'), github.event_name)`,
    );
    const caller: unknown = Bun.YAML.parse(
      workflowSource("network-baseline-record.yml"),
    );
    expect(
      isRecord(caller) && isRecord(caller["jobs"]) && caller["jobs"]["deliver"],
    ).toMatchObject({
      needs: "record",
      uses: "./.github/workflows/network-baseline-deliver.yml",
      permissions: { actions: "read", contents: "read" },
    });
    expect(source).not.toContain("github.event.workflow_run");
    expect(source).toContain(`RUN_ID: ${githubExpression("github.run_id")}`);
    expect(source).toContain(`RECORDED_SHA: ${githubExpression("github.sha")}`);
    expect(deliver.permissions).toEqual({ actions: "read", contents: "read" });
    const validation = deliver.steps.findIndex((step) =>
      step.run?.includes(" validate "),
    );
    const publication = deliver.steps.findIndex(
      (step) =>
        step.with?.["name"] ===
        `network-baseline-main-${githubExpression("github.sha")}`,
    );
    expect(validation).toBeGreaterThan(-1);
    expect(publication).toBeGreaterThan(validation);
    expect(source).not.toContain("signed-commit");
    expect(source).not.toContain("secrets.");
  });

  test("both comparison jobs load the merge-base budget before measuring", () => {
    const jobs = readWorkflowJobs("ci.yml");
    for (const name of ["route-smoke", "e2e-production-shard"]) {
      const job = jobs[name] ?? expect.unreachable(name);
      expect(job.permissions).toMatchObject({
        contents: "read",
        actions: isCanonicalFailureCancellation(job.steps.at(-1))
          ? "write"
          : "read",
      });
      const prepare = job.steps.findIndex(
        (step) => step.uses === "./.github/actions/prepare-network-baseline",
      );
      const comparison = job.steps.findIndex(
        (step) => step.name === "Check route network baseline",
      );
      expect(prepare).toBeGreaterThan(-1);
      expect(comparison).toBeGreaterThan(prepare);
      // Every event that compares also loads the published budget; an event
      // filter here would compare against the frozen committed JSON instead.
      expect(job.steps[prepare]?.if ?? "", name).not.toContain("event_name");
      expect(job.steps[prepare]?.with?.["base-sha"]).toContain(
        "github.event.pull_request.base.sha",
      );
      expect(job.steps[prepare]?.with?.["base-sha"]).toContain(
        "github.event.merge_group.base_sha",
      );
      const checkout = job.steps.find((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );
      expect(checkout?.with?.["fetch-depth"]).toBe(0);
    }
  });
});

describe("reviewed network budgets", () => {
  const prepare = (declarations: unknown[] = []) =>
    prepareComparisonBaseline({
      base: { "/chat": entry(1), "/settings": entry(2) },
      changedPaths: ["apps/web/src/routes/_protected.chat/index.tsx"],
      baseRouteTree: routeTree,
      routeTree,
      declarations,
    });

  test("route edits preserve all old budgets and scope only their route keys", () => {
    const result = prepare();
    expect(result.baseline).toEqual({
      "/chat": entry(1),
      "/settings": entry(2),
    });
    expect(result.changedRoutes).toEqual(["/chat", "/chat target"]);
    expect(result.notices).toEqual([]);
  });

  test("an explicit budget affects only its declared route and reports its reason", () => {
    const result = prepare([
      { route: "/chat", reason: "Additional endpoint", budget: entry(3) },
    ]);
    expect(result.baseline).toEqual({
      "/chat": entry(3),
      "/settings": entry(2),
    });
    expect(result.notices).toEqual(["- `/chat`: `Additional endpoint`"]);
  });

  test.each([
    [null],
    [{ route: "/chat", reason: " ", budget: entry(1) }],
    [{ route: "chat", reason: "Change", budget: entry(1) }],
    [{ route: "/chat", reason: "Change", budget: { depth: -1, requests: [] } }],
    [
      {
        route: "/chat",
        reason: "Change",
        budget: { ...entry(1), dbQueries: { "GET /absent": 10 } },
      },
    ],
    [{ route: "/chat", reason: "Change", budget: entry(1), extra: true }],
    [
      { route: "/chat", reason: "Change", budget: entry(1) },
      { route: "/chat", reason: "Other", budget: entry(2) },
    ],
  ])(
    "invalid or duplicate declarations fail closed",
    (...declarations) => {
      const result = Bun.spawnSync(
        [
          "bun",
          "-e",
          `import { readFileSync } from "node:fs"; import { prepareComparisonBaseline } from "./scripts/network-baseline-scope.ts"; prepareComparisonBaseline(JSON.parse(readFileSync(0, "utf-8")));`,
        ],
        {
          cwd: path.join(import.meta.dirname, ".."),
          stdin: Buffer.from(
            JSON.stringify({
              base: {},
              changedPaths: [],
              baseRouteTree: routeTree,
              routeTree,
              declarations,
            }),
          ),
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toMatch(
        /Invalid network budget declaration|Duplicate network budget declaration/u,
      );
    },
    60_000,
  );

  test("preparation rejects PR edits of shared JSON", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "network-budget-"));
    try {
      const base = path.join(directory, "base.json");
      const tree = path.join(directory, "tree.ts");
      const changed = path.join(directory, "changed");
      writeFileSync(base, JSON.stringify({ "/chat": entry(1) }));
      writeFileSync(tree, routeTree);
      writeFileSync(changed, "apps/web/e2e/network-baseline.json\n");
      const result = Bun.spawnSync(
        [
          "bun",
          "scripts/network-baseline-scope.ts",
          "prepare",
          "--base",
          base,
          "--changed",
          changed,
          "--base-route-tree",
          tree,
          "--route-tree",
          tree,
          "--output",
          path.join(directory, "output.json"),
          "--context",
          path.join(directory, "context.json"),
        ],
        { cwd: path.join(import.meta.dirname, "..") },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        "instead of editing network-baseline.json",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

const installRouteTreeGeneratorFixture = (directory: string) => {
  const script = path.join(
    directory,
    "apps/web/scripts/network-baseline-route-tree.ts",
  );
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
import { childExitStatus } from ${JSON.stringify(path.join(import.meta.dir, "../packages/scripts/src/child-exit-status.ts"))};
const [repository, revision, output] = Bun.argv.slice(2);
if (!repository || !revision || !output || !/^[a-f0-9]{40}$/.test(revision)) process.exit(1);
const result = Bun.spawnSync(["git", "-C", repository, "show", revision + ":apps/web/src/fixture-route-tree.txt"]);
if (result.exitCode !== 0) process.exit(childExitStatus(result));
writeFileSync(output, result.stdout);
`,
  );
};

describe("merge-base preparation integration", () => {
  test("PR merge refs use advanced main rather than the recorded event base", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "network-pr-merge-"));
    const root = path.join(import.meta.dirname, "..");
    const runnerPath = process.env["PATH"];
    if (typeof runnerPath !== "string") {
      expect.unreachable("integration fixture requires PATH");
    }
    const run = (args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(args, { cwd: directory, env: { ...process.env, ...env } });
    const checked = (args: string[]) => {
      const result = run(args);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    const baselinePath = path.join(
      directory,
      "apps/web/e2e/network-baseline.json",
    );
    const treePath = path.join(
      directory,
      "apps/web/src/fixture-route-tree.txt",
    );
    const mainBaseline = { "/chat": entry(8), "/settings": entry(2) };
    const mainTree = `${routeTree}\n// main advances\n`;
    try {
      mkdirSync(path.dirname(baselinePath), { recursive: true });
      mkdirSync(path.dirname(treePath), { recursive: true });
      mkdirSync(path.join(directory, "scripts"));
      mkdirSync(path.join(directory, "bin"));
      writeFileSync(
        path.join(directory, "scripts/network-baseline-scope.ts"),
        readFileSync(path.join(root, "scripts/network-baseline-scope.ts")),
      );
      writeFileSync(
        baselinePath,
        JSON.stringify({ "/chat": entry(1), "/settings": entry(2) }),
      );
      writeFileSync(treePath, routeTree);
      installRouteTreeGeneratorFixture(directory);
      checked(["git", "init", "-b", "main"]);
      checked(["git", "config", "user.name", "Fixture"]);
      checked(["git", "config", "user.email", "fixture@example.test"]);
      checked(["git", "config", "commit.gpgsign", "false"]);
      checked(["git", "add", "apps", "scripts"]);
      checked(["git", "commit", "-m", "recorded base"]);
      const recordedBase = checked(["git", "rev-parse", "HEAD"]);
      checked(["git", "remote", "add", "origin", directory]);
      checked(["git", "switch", "-c", "feature"]);
      writeFileSync(path.join(directory, "feature.txt"), "feature");
      checked(["git", "add", "feature.txt"]);
      checked(["git", "commit", "-m", "feature"]);
      const feature = checked(["git", "rev-parse", "HEAD"]);
      expect(
        checked(["git", "diff", "--name-only", recordedBase, feature]),
      ).toBe("feature.txt");
      checked(["git", "switch", "main"]);
      writeFileSync(baselinePath, JSON.stringify(mainBaseline));
      writeFileSync(treePath, mainTree);
      checked(["git", "add", "apps"]);
      checked(["git", "commit", "-m", "main recording advances"]);
      const advancedMain = checked(["git", "rev-parse", "HEAD"]);
      checked(["git", "merge", "--no-ff", "--no-edit", "feature"]);
      expect(checked(["git", "rev-parse", "HEAD^1"])).toBe(advancedMain);
      expect(checked(["git", "merge-base", "HEAD", recordedBase])).toBe(
        recordedBase,
      );
      expect(
        checked(["git", "diff", "--name-only", recordedBase, "HEAD"]),
      ).toContain("apps/web/e2e/network-baseline.json");
      const gh = path.join(directory, "bin/gh");
      writeFileSync(
        gh,
        '#!/usr/bin/env bash\nprintf \'%s\\n\' \'{"total_count":0,"artifacts":[],"workflow_runs":[]}\'\n',
      );
      chmodSync(gh, 0o755);
      const summary = path.join(directory, "summary");
      writeFileSync(summary, "");
      const prepareScript = path.join(
        root,
        ".github/actions/prepare-network-baseline/prepare.sh",
      );
      const prepare = (script: string) =>
        run(["bash", script], {
          GH_RETRY_SCRIPT: path.join(root, "scripts/gh-retry.sh"),
          PATH: `${path.join(directory, "bin")}:${runnerPath}`,
          BASE_SHA: recordedBase,
          GITHUB_EVENT_NAME: "pull_request",
          NETWORK_BASELINE_PURPOSE: "comparison",
          REPOSITORY: "fixture/fixture",
          RUNNER_TEMP: directory,
          GITHUB_STEP_SUMMARY: summary,
        });
      expect(
        run(["git", "show", `${advancedMain}:apps/web/src/routeTree.gen.ts`])
          .exitCode,
      ).not.toBe(0);
      const result = prepare(prepareScript);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(JSON.parse(readFileSync(baselinePath, "utf-8"))).toEqual(
        mainBaseline,
      );
      expect(
        JSON.parse(
          readFileSync(
            path.join(directory, "apps/web/e2e/.network-baseline-base.json"),
            "utf-8",
          ),
        ),
      ).toEqual(mainBaseline);
      expect(
        readFileSync(path.join(directory, "base-route-tree.gen.ts"), "utf-8"),
      ).toBe(mainTree);
      expect(
        readFileSync(path.join(directory, "head-route-tree.gen.ts"), "utf-8"),
      ).toBe(mainTree);
      expect(
        readFileSync(
          path.join(directory, "apps/web/e2e/.network-baseline-changed"),
          "utf-8",
        ).trim(),
      ).toBe("feature.txt");
      expect(readFileSync(summary, "utf-8")).toContain(
        `merge base ${advancedMain}`,
      );
      const script = readFileSync(prepareScript, "utf-8");
      const mutant = script.replace(
        /if \[\[ "\$\{GITHUB_EVENT_NAME:-\}"[\s\S]*?^fi\n/mu,
        "",
      );
      expect(mutant).not.toBe(script);
      const mutantPath = path.join(directory, "prepare-mutant.sh");
      writeFileSync(
        path.join(directory, "select-recording.sh"),
        readFileSync(
          path.join(
            root,
            ".github/actions/prepare-network-baseline/select-recording.sh",
          ),
        ),
      );
      writeFileSync(mutantPath, mutant);
      const mutation = prepare(mutantPath);
      expect(mutation.exitCode).not.toBe(0);
      expect(mutation.stderr.toString()).toContain(
        "PRs must declare network budget changes instead of editing network-baseline.json",
      );
      const committedTreeMutant = script.replace(
        'bun apps/web/scripts/network-baseline-route-tree.ts "$repository" "$since" "$base_tree"',
        'git show "$since:apps/web/src/routeTree.gen.ts" > "$base_tree"',
      );
      expect(committedTreeMutant).not.toBe(script);
      writeFileSync(mutantPath, committedTreeMutant);
      const committedTreeMutation = prepare(mutantPath);
      expect(committedTreeMutation.exitCode).not.toBe(0);
      expect(committedTreeMutation.stderr.toString()).toContain(
        "does not exist",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("merging main changes the baseline source without editing the PR JSON", () => {
    const directory = mkdtempSync(
      path.join(os.tmpdir(), "network-merge-base-"),
    );
    const root = path.join(import.meta.dirname, "..");
    const runnerPath = process.env["PATH"];
    if (typeof runnerPath !== "string") {
      expect.unreachable("integration fixture requires PATH");
    }
    const run = (args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(args, {
        cwd: directory,
        env: { ...process.env, ...env },
      });
    const checked = (args: string[]) => {
      const result = run(args);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    try {
      mkdirSync(path.join(directory, "apps/web/e2e"), { recursive: true });
      mkdirSync(path.join(directory, "apps/web/src"), { recursive: true });
      mkdirSync(path.join(directory, "scripts"));
      mkdirSync(path.join(directory, "bin"));
      writeFileSync(
        path.join(directory, "scripts/network-baseline-scope.ts"),
        readFileSync(path.join(root, "scripts/network-baseline-scope.ts")),
      );
      writeFileSync(
        path.join(directory, "apps/web/e2e/network-baseline.json"),
        JSON.stringify({ "/chat": entry(1), "/settings": entry(2) }),
      );
      writeFileSync(
        path.join(directory, "apps/web/src/fixture-route-tree.txt"),
        routeTree,
      );
      installRouteTreeGeneratorFixture(directory);
      checked(["git", "init", "-b", "main"]);
      checked(["git", "config", "user.name", "Fixture"]);
      checked(["git", "config", "user.email", "fixture@example.test"]);
      checked(["git", "config", "commit.gpgsign", "false"]);
      checked(["git", "add", "apps", "scripts"]);
      checked(["git", "commit", "-m", "fixture"]);
      const firstBase = checked(["git", "rev-parse", "HEAD"]);
      checked(["git", "remote", "add", "origin", directory]);
      checked(["git", "switch", "-c", "feature"]);
      writeFileSync(path.join(directory, "feature.txt"), "feature");
      checked(["git", "add", "feature.txt"]);
      checked(["git", "commit", "-m", "feature"]);
      const feature = checked(["git", "rev-parse", "HEAD"]);
      const gh = path.join(directory, "bin/gh");
      writeFileSync(
        gh,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ "$TEST_ARTIFACTS" == fail ]]; then exit 42; fi
case "$*" in
  *actions/artifacts/3/zip*) cat "$TEST_ZIP_NEW" ;;
  *actions/artifacts/*/zip*) cat "$TEST_ZIP" ;;
  *actions/artifacts*) printf '%s\\n' "$TEST_ARTIFACTS" ;;
  *actions/workflows/*) printf '%s\\n' "$TEST_RUNS" ;;
  *actions/runs/*) printf '%s\\n' "$TEST_RUN" ;;
  *) exit 1 ;;
esac
`,
      );
      chmodSync(gh, 0o755);
      // The action does not provision ripgrep; exercise inheritance without it.
      const unavailableRipgrep = path.join(directory, "bin/rg");
      writeFileSync(unavailableRipgrep, "#!/usr/bin/env bash\nexit 127\n");
      chmodSync(unavailableRipgrep, 0o755);
      const summary = path.join(directory, "summary");
      writeFileSync(summary, "");
      const prepare = (
        base: string,
        artifactEnv: Record<string, string> = {},
      ) => {
        const result = run(
          [
            "bash",
            path.join(
              root,
              ".github/actions/prepare-network-baseline/prepare.sh",
            ),
          ],
          {
            PATH: `${path.join(directory, "bin")}:${runnerPath}`,
            BASE_SHA: base,
            GITHUB_EVENT_NAME: "push",
            REPOSITORY: "fixture/fixture",
            RUNNER_TEMP: directory,
            GITHUB_STEP_SUMMARY: summary,
            TEST_ARTIFACTS: '{"total_count":0,"artifacts":[]}',
            TEST_RUNS: '{"workflow_runs":[]}',
            ...artifactEnv,
          },
        );
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        return JSON.parse(
          readFileSync(
            path.join(directory, "apps/web/e2e/network-baseline.json"),
            "utf-8",
          ),
        );
      };
      expect(prepare(firstBase)).toEqual({
        "/chat": entry(1),
        "/settings": entry(2),
      });
      checked(["git", "restore", "apps/web/e2e/network-baseline.json"]);
      checked(["git", "switch", "main"]);
      writeFileSync(path.join(directory, "main.txt"), "main advances");
      checked(["git", "add", "main.txt"]);
      checked(["git", "commit", "-m", "main advance"]);
      const nextBase = checked(["git", "rev-parse", "HEAD"]);
      checked(["git", "switch", "feature"]);
      checked(["git", "merge", "--no-edit", "main"]);
      expect(nextBase).not.toBe(firstBase);
      expect(checked(["git", "diff", "--name-only", firstBase, feature])).toBe(
        "feature.txt",
      );
      expect(prepare(nextBase)).toEqual({
        "/chat": entry(1),
        "/settings": entry(2),
      });
      expect(checked(["git", "diff", "--name-only", nextBase, "HEAD"])).toBe(
        "feature.txt",
      );
      expect(readFileSync(summary, "utf-8")).toContain(
        `merge base ${nextBase}`,
      );
      const publication = { "/chat": entry(8), "/settings": entry(2) };
      mkdirSync(path.join(directory, "published"));
      writeFileSync(
        path.join(directory, "published/network-baseline.json"),
        JSON.stringify(publication),
      );
      const zip = run([
        "zip",
        "-jq",
        path.join(directory, "baseline.zip"),
        path.join(directory, "published/network-baseline.json"),
      ]);
      expect(zip.exitCode).toBe(0);
      const artifactEnv = {
        TEST_ARTIFACTS: JSON.stringify({
          total_count: 1,
          artifacts: [
            {
              id: 1,
              name: `network-baseline-main-${firstBase}`,
              expired: false,
              workflow_run: { id: 2 },
            },
          ],
        }),
        TEST_RUNS: JSON.stringify({
          workflow_runs: [{ event: "push", head_sha: firstBase }],
        }),
        TEST_RUN: JSON.stringify({
          path: ".github/workflows/network-baseline-deliver.yml",
          event: "workflow_run",
          conclusion: "success",
          head_branch: "main",
          head_sha: firstBase,
          head_repository: { full_name: "fixture/fixture" },
        }),
        TEST_ZIP: path.join(directory, "baseline.zip"),
      };
      expect(prepare(nextBase, artifactEnv)).toEqual(publication);
      expect(readFileSync(summary, "utf-8")).toContain(
        `recording at ${firstBase} (merge base ${nextBase})`,
      );
      expect(
        prepare(nextBase, {
          ...artifactEnv,
          TEST_RUN: JSON.stringify({
            path: ".github/workflows/ci.yml",
            event: "pull_request",
            conclusion: "success",
            head_branch: "feature",
            head_sha: firstBase,
            head_repository: { full_name: "fixture/fixture" },
          }),
        }),
      ).toEqual({ "/chat": entry(1), "/settings": entry(2) });
      mkdirSync(path.join(directory, "apps/web/e2e/network-budgets"));
      writeFileSync(
        path.join(directory, "apps/web/e2e/network-budgets/change.json"),
        JSON.stringify({
          route: "/chat",
          reason: "Additional endpoint",
          budget: entry(9),
        }),
      );
      checked(["git", "add", "apps/web/e2e/network-budgets/change.json"]);
      checked(["git", "commit", "-m", "declare budget"]);
      expect(prepare(nextBase)).toEqual({
        "/chat": entry(9),
        "/settings": entry(2),
      });
      const inheritedBase = checked(["git", "rev-parse", "HEAD"]);
      expect(prepare(inheritedBase)).toEqual({
        "/chat": entry(1),
        "/settings": entry(2),
      });
      // Main must seed declarations even when no request observes them yet.
      const declared = { "/chat": entry(9), "/settings": entry(2) };
      expect(
        prepare(inheritedBase, { NETWORK_BASELINE_PURPOSE: "recording" }),
      ).toEqual(declared);
      expect(
        prepare(inheritedBase, {
          ...artifactEnv,
          NETWORK_BASELINE_PURPOSE: "recording",
        }),
      ).toEqual(declared);
      // The next publication contains the declaration plus a measured peak.
      const newerPublication = { "/chat": entry(10), "/settings": entry(2) };
      writeFileSync(
        path.join(directory, "published/network-baseline.json"),
        JSON.stringify(newerPublication),
      );
      checked([
        "zip",
        "-jq",
        path.join(directory, "newer-baseline.zip"),
        path.join(directory, "published/network-baseline.json"),
      ]);
      checked(["git", "restore", "apps/web/e2e/network-baseline.json"]);
      writeFileSync(path.join(directory, "docs.txt"), "main advances again");
      checked(["git", "add", "docs.txt"]);
      checked(["git", "commit", "-m", "docs advance"]);
      const latestBase = checked(["git", "rev-parse", "HEAD"]);
      const shuffledArtifacts = {
        ...artifactEnv,
        TEST_ARTIFACTS: JSON.stringify({
          total_count: 2,
          artifacts: [
            {
              id: 1,
              name: `network-baseline-main-${firstBase}`,
              expired: false,
              workflow_run: { id: 2 },
            },
            {
              id: 3,
              name: `network-baseline-main-${inheritedBase}`,
              expired: false,
              workflow_run: { id: 4 },
            },
          ],
        }),
        TEST_ZIP_NEW: path.join(directory, "newer-baseline.zip"),
      };
      for (const sources of [
        [firstBase, inheritedBase, nextBase],
        [nextBase, inheritedBase, firstBase],
        [inheritedBase, firstBase, nextBase],
      ]) {
        const inherited = {
          ...shuffledArtifacts,
          TEST_RUNS: JSON.stringify({
            workflow_runs: sources.map((head_sha) => ({
              event: "push",
              head_sha,
            })),
          }),
        };
        expect(prepare(latestBase, inherited)).toEqual(newerPublication);
        expect(
          prepare(latestBase, {
            ...inherited,
            NETWORK_BASELINE_PURPOSE: "recording",
          }),
        ).toEqual(newerPublication);
      }
      const unavailable = run(
        [
          "bash",
          path.join(
            root,
            ".github/actions/prepare-network-baseline/prepare.sh",
          ),
        ],
        {
          PATH: `${path.join(directory, "bin")}:${runnerPath}`,
          BASE_SHA: nextBase,
          GITHUB_EVENT_NAME: "push",
          REPOSITORY: "fixture/fixture",
          RUNNER_TEMP: directory,
          GITHUB_STEP_SUMMARY: summary,
          TEST_ARTIFACTS: "fail",
        },
      );
      expect(unavailable.exitCode).toBe(1);
      expect(unavailable.stderr.toString()).toContain("ERROR");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  test("main comparisons exempt routes changed since an inherited recording", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "network-since-"));
    const root = path.join(import.meta.dirname, "..");
    const runnerPath = process.env["PATH"];
    if (typeof runnerPath !== "string") {
      expect.unreachable("integration fixture requires PATH");
    }
    const run = (args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(args, { cwd: directory, env: { ...process.env, ...env } });
    const checked = (args: string[]) => {
      const result = run(args);
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    const read = (file: string) =>
      readFileSync(path.join(directory, file), "utf-8");
    const chatRoute = "apps/web/src/routes/_protected.chat/index.tsx";
    const committed = { "/chat": entry(1), "/settings": entry(2) };
    const publication = { "/chat": entry(8), "/settings": entry(2) };
    try {
      mkdirSync(path.join(directory, "apps/web/e2e"), { recursive: true });
      mkdirSync(path.join(directory, "apps/web/src/routes/_protected.chat"), {
        recursive: true,
      });
      mkdirSync(path.join(directory, "scripts"));
      mkdirSync(path.join(directory, "bin"));
      mkdirSync(path.join(directory, "published"));
      writeFileSync(
        path.join(directory, "scripts/network-baseline-scope.ts"),
        readFileSync(path.join(root, "scripts/network-baseline-scope.ts")),
      );
      writeFileSync(
        path.join(directory, "apps/web/e2e/network-baseline.json"),
        JSON.stringify(committed),
      );
      writeFileSync(
        path.join(directory, "apps/web/src/fixture-route-tree.txt"),
        routeTree,
      );
      writeFileSync(path.join(directory, chatRoute), "export {};\n");
      installRouteTreeGeneratorFixture(directory);
      writeFileSync(
        path.join(directory, "published/network-baseline.json"),
        JSON.stringify(publication),
      );
      checked([
        "zip",
        "-jq",
        path.join(directory, "baseline.zip"),
        path.join(directory, "published/network-baseline.json"),
      ]);
      checked(["git", "init", "-b", "main"]);
      checked(["git", "config", "user.name", "Fixture"]);
      checked(["git", "config", "user.email", "fixture@example.test"]);
      checked(["git", "config", "commit.gpgsign", "false"]);
      checked(["git", "add", "apps", "scripts"]);
      checked(["git", "commit", "-m", "recorded"]);
      const recorded = checked(["git", "rev-parse", "HEAD"]);
      checked(["git", "remote", "add", "origin", directory]);
      // Main's own committed-baseline edit is not a PR edit of shared JSON.
      writeFileSync(
        path.join(directory, "apps/web/e2e/network-baseline.json"),
        JSON.stringify({ ...committed, "/": entry(1) }),
      );
      checked(["git", "commit", "-am", "bootstrap edit"]);
      writeFileSync(path.join(directory, chatRoute), "export const x = 1;\n");
      checked(["git", "commit", "-am", "route change"]);
      const head = checked(["git", "rev-parse", "HEAD"]);
      const gh = path.join(directory, "bin/gh");
      writeFileSync(
        gh,
        `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *actions/artifacts/*/zip*) cat "$TEST_ZIP" ;;
  *actions/artifacts*) printf '%s\\n' "$TEST_ARTIFACTS" ;;
  *actions/workflows/*) printf '%s\\n' "$TEST_RUNS" ;;
  *actions/runs/*) printf '%s\\n' "$TEST_RUN" ;;
  *) exit 1 ;;
esac
`,
      );
      chmodSync(gh, 0o755);
      const summary = path.join(directory, "summary");
      const prepareRun = (source: string, purpose: string, base = head) => {
        writeFileSync(summary, "");
        checked([
          "git",
          "checkout",
          "--",
          "apps/web/e2e/network-baseline.json",
        ]);
        const result = run(
          [
            "bash",
            path.join(
              root,
              ".github/actions/prepare-network-baseline/prepare.sh",
            ),
          ],
          {
            PATH: `${path.join(directory, "bin")}:${runnerPath}`,
            BASE_SHA: base,
            GITHUB_EVENT_NAME: "push",
            NETWORK_BASELINE_PURPOSE: purpose,
            REPOSITORY: "fixture/fixture",
            RUNNER_TEMP: directory,
            GITHUB_STEP_SUMMARY: summary,
            TEST_ARTIFACTS: JSON.stringify({
              total_count: 1,
              artifacts: [
                {
                  id: 1,
                  name: `network-baseline-main-${source}`,
                  expired: false,
                  workflow_run: { id: 2 },
                },
              ],
            }),
            TEST_RUNS: JSON.stringify({
              workflow_runs: [{ event: "push", head_sha: source }],
            }),
            TEST_RUN: JSON.stringify({
              path: ".github/workflows/network-baseline-deliver.yml",
              event: "workflow_run",
              conclusion: "success",
              head_branch: "main",
              head_sha: source,
              head_repository: { full_name: "fixture/fixture" },
            }),
            TEST_ZIP: path.join(directory, "baseline.zip"),
          },
        );
        return result;
      };
      const prepare = (source: string, purpose: string) => {
        const result = prepareRun(source, purpose);
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(read("summary")).toContain(`recording at ${source}`);
        return {
          baseline: JSON.parse(read("apps/web/e2e/network-baseline.json")),
          changed: read("apps/web/e2e/.network-baseline-changed")
            .split("\n")
            .filter(Boolean),
          context: JSON.parse(
            read("apps/web/e2e/.network-baseline-context.json"),
          ),
          summary: read("summary"),
        };
      };
      const inherited = prepare(recorded, "comparison");
      expect(inherited.baseline).toEqual(publication);
      expect(inherited.changed).toEqual([chatRoute]);
      expect(inherited.context).toEqual(["/chat", "/chat target"]);
      expect(inherited.summary).toContain(
        `comparison exempts routes changed since ${recorded}`,
      );
      const current = prepare(head, "comparison");
      expect(current.baseline).toEqual(publication);
      expect(current.changed).toEqual([]);
      expect(current.context).toEqual([]);
      expect(current.summary).toContain(
        `comparison exempts routes changed since ${head}`,
      );
      // Recording seeds the checked-out commit and scopes nothing.
      const recording = prepare(recorded, "recording");
      expect(recording.baseline).toEqual(publication);
      expect(recording.changed).toEqual([]);
      expect(recording.context).toEqual([]);
      expect(recording.summary).not.toContain("comparison exempts");
      // A PR atop an unrecorded main keeps its own changes in scope too.
      checked(["git", "switch", "-q", "-c", "feature"]);
      writeFileSync(path.join(directory, "feature.txt"), "feature\n");
      checked(["git", "add", "feature.txt"]);
      checked(["git", "commit", "-qm", "feature"]);
      const pr = prepareRun(recorded, "comparison", head);
      expect(pr.exitCode, pr.stderr.toString()).toBe(0);
      expect(
        read("apps/web/e2e/.network-baseline-changed")
          .split("\n")
          .filter(Boolean),
      ).toEqual([chatRoute, "feature.txt"]);
      // The PR's own baseline edit is still refused.
      writeFileSync(
        path.join(directory, "apps/web/e2e/network-baseline.json"),
        JSON.stringify({ ...committed, "/pr": entry(1) }),
      );
      checked(["git", "commit", "-qam", "pr baseline edit"]);
      const prEdit = prepareRun(recorded, "comparison", head);
      expect(prEdit.exitCode).not.toBe(0);
      expect(prEdit.stderr.toString()).toContain(
        "PRs must declare network budget changes",
      );
      checked(["git", "switch", "-q", "main"]);
      // A recording far behind the compared commit fails instead of
      // exempting every route changed since it.
      writeFileSync(path.join(directory, chatRoute), "export const x = 2;\n");
      const later = new Date(Date.now() + 40 * 60 * 60 * 1000).toISOString();
      const lateCommit = run(["git", "commit", "-qam", "late route change"], {
        GIT_AUTHOR_DATE: later,
        GIT_COMMITTER_DATE: later,
      });
      expect(lateCommit.exitCode, lateCommit.stderr.toString()).toBe(0);
      const late = checked(["git", "rev-parse", "HEAD"]);
      const stale = prepareRun(recorded, "comparison", late);
      expect(stale.exitCode).not.toBe(0);
      expect(stale.stderr.toString()).toContain(
        `recording stale since ${recorded}`,
      );
      expect(read("summary")).toContain(`recording stale since ${recorded}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
