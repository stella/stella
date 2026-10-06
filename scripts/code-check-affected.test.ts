import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CODE_CHECK_LEGS,
  ownsCodeCheckPath,
} from "../packages/scripts/src/code-quality-partition";
import {
  ALL_WORKSPACE_CACHE_INPUTS,
  ALL_WORKSPACE_TYPECHECK_CACHE_INPUTS,
  CommandFailedError,
  DEPENDENCY_CACHE_INPUTS,
  failureExitCode,
  formatCheckFailure,
  LINT_ONLY_CACHE_INPUTS,
  executeCheckCommands,
  planCheck,
  planFullCheck,
  planResultBoundaryLint,
  PLUGIN_FIXTURE_INPUTS,
  PLUGIN_REGISTRY_INPUTS,
  ROOT_SCRIPT_LINT_INPUTS,
  SHARED_COMPILER_CACHE_INPUTS,
  TYPECHECK_ONLY_CACHE_INPUTS,
  resultBoundaryLintCommand,
  scopedCommands,
  summarizeCheckFailure,
} from "./code-check-affected";
import { isChangedLintPath } from "./lint-paths";

const WORKSPACES = new Set([
  "apps/api",
  "apps/landing",
  "apps/web",
  "packages/errors",
  "packages/scripts",
  "packages/typescript-config",
  "packages/ui",
]);

const plan = (
  changedPaths: string[],
  affectedWorkspacePaths: string[],
  presentChangedPaths = changedPaths,
) =>
  planCheck({
    changedPaths,
    presentChangedPaths,
    affectedWorkspacePaths,
    workspacePaths: WORKSPACES,
  });

describe("changed-file result boundary lint", () => {
  test.each([
    ["README.md"],
    ["scripts/guard.ts"],
    ["apps/api/src/lib/client.test.ts"],
    ["apps/api/src/lib/document-processing-queue.ts"],
  ])("does not resolve or measure debt for %s", (file) => {
    expect(
      planResultBoundaryLint({
        files: [file],
        mergeBase: null,
        resolveMergeBase: () => {
          throw new Error("Unrelated files must not resolve a debt base");
        },
        measureDebt: () => {
          throw new Error("Unrelated files must not measure debt");
        },
        report: () => {
          throw new Error("Unrelated files must not report skipped checks");
        },
      }),
    ).toBeNull();
  });

  test("reuses the affected scope's merge base when measuring candidate debt", () => {
    const measuredBases: string[] = [];
    const file = "apps/api/src/lib/new-client.ts";
    expect(
      planResultBoundaryLint({
        files: ["README.md", file],
        mergeBase: "planned-merge-base",
        resolveMergeBase: () => {
          throw new Error(
            "Affected checks must reuse their planned merge base",
          );
        },
        measureDebt: (base) => {
          measuredBases.push(base);
          return new Set();
        },
        report: () => {
          throw new Error("An available base must not skip checks");
        },
      }),
    ).toEqual(resultBoundaryLintCommand([file], new Set()));
    expect(measuredBases).toEqual(["planned-merge-base"]);
  });

  test("the full scope resolves a base and excludes its measured debt", () => {
    const debtFile = "apps/api/src/lib/old-client.ts";
    const cleanFile = "apps/api/src/lib/new-client.ts";
    const measuredBases: string[] = [];
    expect(
      planResultBoundaryLint({
        files: [debtFile, cleanFile],
        mergeBase: null,
        resolveMergeBase: () => "full-merge-base",
        measureDebt: (base) => {
          measuredBases.push(base);
          return new Set([debtFile]);
        },
        report: () => {
          throw new Error("An available base must not skip checks");
        },
      }),
    ).toEqual(resultBoundaryLintCommand([cleanFile], new Set()));
    expect(measuredBases).toEqual(["full-merge-base"]);
  });

  test("the full scope clearly skips the extra pass without a comparison base", () => {
    const messages: string[] = [];
    expect(
      planResultBoundaryLint({
        files: ["apps/api/src/lib/new-client.ts"],
        mergeBase: null,
        resolveMergeBase: () => null,
        measureDebt: () => {
          throw new Error("A missing base must not measure debt");
        },
        report: (message) => {
          messages.push(message);
        },
      }),
    ).toBeNull();
    expect(messages).toEqual([
      "code-check: skipping exact result boundary lint; no merge base for origin/main (normal lint checks still run)\n",
    ]);
  });

  test("enforces the exact Oxlint rules for files without baseline debt", () => {
    expect(
      resultBoundaryLintCommand(
        [
          "apps/api/src/lib/new-client.ts",
          "apps/api/src/lib/new-client.ts",
          "packages/boe/src/new-client.ts",
        ],
        new Set(),
      ),
    ).toEqual([
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.result-boundary.config.ts",
      "--deny-warnings",
      "apps/api/src/lib/new-client.ts",
      "packages/boe/src/new-client.ts",
    ]);
  });

  test("skips measured debt, boundaries, generated output, tests, and unrelated source", () => {
    expect(
      resultBoundaryLintCommand(
        [
          "apps/api/src/handlers/case-law/ingestion/adapters/eu-ecj.ts",
          "apps/api/src/lib/document-processing-queue.ts",
          "apps/api/src/lib/document-processing-queue.test.ts",
          "apps/api/src/mcp/generated/capability-dispatch/matters.list.ts",
          "packages/start-runtime/src/runtime.ts",
          "packages/ssr-testkit/src/assert-document.ts",
          // apps/landing is outside RESULT_CONVENTION_SOURCE_GLOBS and carries
          // an opt-out reason, so its source is not planned for this lint.
          "apps/landing/src/example.ts",
          "apps/api/src/lib/new-client.ts",
          "apps/web/src/lib/example.ts",
        ],
        new Set([
          "apps/api/src/handlers/case-law/ingestion/adapters/eu-ecj.ts",
          "apps/api/src/lib/document-processing-queue.ts",
          "packages/start-runtime/src/runtime.ts",
          "packages/ssr-testkit/src/assert-document.ts",
        ]),
      ),
    ).toEqual([
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.result-boundary.config.ts",
      "--deny-warnings",
      "apps/api/src/lib/new-client.ts",
      "apps/web/src/lib/example.ts",
    ]);
  });
});

describe("affected code-check planning", () => {
  test.each([
    ["apps/web/src/styles/app.css", ["apps/web"]],
    ["packages/ui/src/styles/theme.css", ["packages/ui"]],
    [".stylelintrc.json", []],
    [".gitignore", []],
    ["scripts/stylelint.test.ts", []],
    ["package.json", []],
    ["bun.lock", []],
  ])("runs CSS checks when %s changes", (changedPath, affected) => {
    const planned = plan([changedPath], affected);
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(scopedCommands(planned)).toContainEqual(["bun", "run", "lint:css"]);
  });

  test("checks complete changed workspaces and reverse dependants", () => {
    expect(
      plan(
        ["packages/ui/src/button.tsx"],
        ["packages/ui", "apps/web", "apps/landing"],
      ),
    ).toEqual({
      type: "scoped",
      lint: {
        type: "targets",
        targets: ["apps/landing", "apps/web", "packages/ui"],
      },
      typecheck: {
        type: "targets",
        targets: ["apps/landing", "apps/web", "packages/ui"],
      },
      rootLintPaths: [],
      rootChecks: ["env", "assets", "rule-decisions", "repo-typecheck"],
    });
  });

  test("does not run workspace analysis for documentation-only changes", () => {
    expect(plan(["README.md"], [])).toEqual({
      type: "scoped",
      lint: { type: "targets", targets: [] },
      typecheck: { type: "targets", targets: [] },
      rootLintPaths: [],
      rootChecks: ["env", "assets", "rule-decisions", "repo-typecheck"],
    });
  });

  test("caches lint and typecheck per affected workspace", () => {
    const planned = plan(
      ["packages/ui/src/button.tsx"],
      ["apps/web", "packages/ui"],
    );
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    const commands = scopedCommands(planned);
    expect(commands).toContainEqual(["bun", "run", "env:check"]);
    expect(commands).toContainEqual(["bun", "run", "assets:check"]);
    expect(commands).toContainEqual([
      "bun",
      "--bun",
      "turbo",
      "run",
      "lint",
      "typecheck",
      "--concurrency=2",
      "--continue=dependencies-successful",
      "--filter=./apps/web",
      "--filter=./packages/ui",
    ]);
    expect(commands).toContainEqual([
      "bun",
      "--bun",
      "turbo",
      "run",
      "typecheck:repo",
      "--concurrency=2",
      "--continue=dependencies-successful",
    ]);
  });

  test("lints changed root scripts outside Turbo workspaces", () => {
    const planned = plan(["scripts/guard.ts"], []);
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    const commands = scopedCommands(planned);

    expect(commands).toContainEqual([
      "bun",
      "scripts/ci-generated-sources.ts",
      "prepare",
    ]);
    const oxc = commands.find((command) => command.includes("oxlint"));
    expect(oxc).toContain("--type-aware");
    expect(oxc).toContain("--type-check");
    expect(oxc?.at(-1)).toBe("scripts/guard.ts");
  });

  test("checks configured adapter paths without trying to lint a deleted source", () => {
    expect(plan(["packages/ui/src/removed.ts"], ["packages/ui"], [])).toEqual({
      type: "scoped",
      lint: { type: "targets", targets: ["packages/ui"] },
      typecheck: { type: "targets", targets: ["packages/ui"] },
      rootLintPaths: [],
      rootChecks: [
        "env",
        "assets",
        "plugin-registry",
        "rule-decisions",
        "repo-typecheck",
      ],
    });
  });

  test.each([
    ".npmrc",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "turbo.json",
    "packages/typescript-config/base.json",
    "patches/vite.patch",
    "types/react-css-properties.d.ts",
  ])("checks all workspaces for dependency input %s", (changedPath) => {
    const planned = plan([changedPath], []);
    expect(planned.type).toBe("scoped");
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(planned.lint).toEqual({ type: "all" });
    expect(planned.typecheck).toEqual({ type: "all" });
  });

  test("shared compiler changes also invalidate plugin fixtures", () => {
    const planned = plan(["packages/typescript-config/base.json"], []);
    expect(planned.type).toBe("scoped");
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(planned.rootChecks).toContain("plugin-fixtures");
  });

  // A changed rule source is linted by the plugin-fixtures check, which lints
  // every rule source, so it is not linted a second time as a root path.
  test.each<[string, string[]]>([
    ["oxlint.config.ts", ["oxlint.config.ts"]],
    [".oxlint-plugins/no-raw-use-effect.ts", []],
  ])(
    "invalidates lint without discarding typecheck cache for %s",
    (changedPath, rootLintPaths) => {
      expect(plan([changedPath], [])).toEqual({
        type: "scoped",
        lint: { type: "all" },
        typecheck: { type: "targets", targets: [] },
        rootLintPaths,
        rootChecks: [
          "env",
          "assets",
          "plugin-registry",
          "rule-decisions",
          "plugin-fixtures",
          "root-script-lint",
          "repo-typecheck",
        ],
      });
    },
  );

  test("a bounded-read owner change invalidates all lint and its owning typecheck", () => {
    const planned = plan(["apps/api/src/lib/db/read-bounded.ts"], ["apps/api"]);
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(planned.lint).toEqual({ type: "all" });
    expect(planned.typecheck).toEqual({
      type: "targets",
      targets: ["apps/api"],
    });
    expect(planned.rootChecks).toContain("plugin-fixtures");
  });

  test("the shared tooling config invalidates only workspace lint", () => {
    expect(plan(["tsconfig.tooling.json"], [])).toEqual({
      type: "scoped",
      lint: { type: "all" },
      typecheck: { type: "targets", targets: [] },
      rootLintPaths: [],
      rootChecks: ["env", "assets", "rule-decisions", "repo-typecheck"],
    });
  });

  test.each([
    ["scripts/check-oxlint-plugin-registry.ts", "plugin-registry"],
    ["scripts/lint-oxlint-fixtures.sh", "plugin-fixtures"],
    ["scripts/oxlint-safe-fixers.test.ts", "plugin-fixtures"],
    ["scripts/oxlint-typebox-unsafe.test.ts", "plugin-fixtures"],
    ["scripts/oxlint-additional-guards.test.ts", "plugin-fixtures"],
    ["scripts/check-oxlint-fixture-counts.ts", "plugin-fixtures"],
    ["scripts/lint-root-scripts.sh", "root-script-lint"],
    ["scripts/tsconfig.json", "root-script-lint"],
    ["tsconfig.json", "plugin-fixtures"],
    ["tsconfig.scripts.json", "root-script-lint"],
  ] as const)(
    "runs only the owning root check for %s",
    (changedPath, rootCheck) => {
      const planned = plan([changedPath], []);
      expect(planned.type).toBe("scoped");
      if (planned.type !== "scoped") {
        throw new Error("Expected a scoped code-check plan");
      }
      expect(planned.lint).toEqual({ type: "targets", targets: [] });
      expect(planned.typecheck).toEqual({ type: "targets", targets: [] });
      expect(planned.rootChecks).toHaveLength(5);
      expect(planned.rootChecks).toEqual(
        expect.arrayContaining([
          "env",
          "assets",
          "rule-decisions",
          rootCheck,
          "repo-typecheck",
        ]),
      );
    },
  );

  test("a lint-global input does not widen affected typechecks", () => {
    const planned = plan(
      ["oxlint.config.ts", "apps/web/src/route.tsx"],
      ["apps/web"],
    );
    expect(planned.type).toBe("scoped");
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(planned.lint).toEqual({ type: "all" });
    expect(planned.typecheck).toEqual({
      type: "targets",
      targets: ["apps/web"],
    });

    const commands = scopedCommands(planned);
    expect(commands).toContainEqual([
      "bun",
      "--bun",
      "turbo",
      "run",
      "lint",
      "--concurrency=2",
      "--continue=dependencies-successful",
    ]);
    expect(commands).toContainEqual([
      "bun",
      "--bun",
      "turbo",
      "run",
      "typecheck",
      "--concurrency=2",
      "--continue=dependencies-successful",
      "--filter=./apps/web",
    ]);
  });

  test("the shared TypeScript runner invalidates only workspace typechecks", () => {
    const planned = plan(
      ["packages/scripts/src/tsc-native.ts"],
      ["packages/scripts"],
    );
    expect(planned.type).toBe("scoped");
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(planned.lint).toEqual({
      type: "targets",
      targets: ["packages/scripts"],
    });
    expect(planned.typecheck).toEqual({ type: "all" });
  });

  test("global dependency inputs use cacheable Turbo tasks", () => {
    const planned = plan(["bunfig.toml"], []);
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(scopedCommands(planned)).toContainEqual([
      "bun",
      "--bun",
      "turbo",
      "run",
      "lint",
      "typecheck",
      "--concurrency=2",
      "--continue=dependencies-successful",
    ]);
  });

  test.each(
    ROOT_SCRIPT_LINT_INPUTS.map((input) =>
      input.slice("$TURBO_ROOT$/".length).replace(/\/\*\*$/u, "/fixture.ts"),
    ),
  )("shared root-script input %s schedules full root lint", (changedPath) => {
    const workspace = [...WORKSPACES].find((workspacePath) =>
      changedPath.startsWith(`${workspacePath}/`),
    );
    const planned = plan([changedPath], workspace ? [workspace] : []);
    expect(planned.type).toBe("scoped");
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(planned.rootChecks).toContain("root-script-lint");
  });

  test("falls back when Turbo omits the directly changed workspace", () => {
    expect(plan(["apps/api/src/server.ts"], ["apps/web"])).toEqual({
      type: "fallback",
      changedPath: "apps/api/src/server.ts",
    });
  });

  test("falls back for an unknown workspace directory", () => {
    expect(plan(["apps/unknown/src/main.ts"], [])).toEqual({
      type: "fallback",
      changedPath: "apps/unknown/src/main.ts",
    });
  });

  test("falls back when Turbo returns a non-workspace target", () => {
    expect(plan(["README.md"], ["tools/unknown"])).toEqual({
      type: "fallback",
      changedPath: "invalid Turbo workspace output",
    });
  });
});

describe("changed lint path selection", () => {
  test.each([
    "apps/api/src/server.ts",
    "apps/web/src/route.tsx",
    "scripts/guard.mjs",
    "scripts/worker.mts",
    "packages/ui/vite.config.js",
    "apps/web/src/client.gen.mts",
    "apps/api/src/generated/schema.ts",
  ])("includes lintable source %s", (changedPath) => {
    expect(isChangedLintPath(changedPath)).toBe(true);
  });

  test.each([
    "README.md",
    "apps/web/src/routeTree.gen.ts",
    "apps/api/src/mcp/generated/capability-dispatch/matters.list.ts",
    "apps/api/src/not-real.mtsx",
    "packages/ui/node_modules/library/index.js",
  ])("excludes non-source or generated path %s", (changedPath) => {
    expect(isChangedLintPath(changedPath)).toBe(false);
  });
});

describe("Turbo cache input contract", () => {
  test("each plugin check invalidates on its own implementation", () => {
    expect(PLUGIN_REGISTRY_INPUTS).toContain(
      "$TURBO_ROOT$/scripts/check-oxlint-plugin-registry.ts",
    );
    expect(PLUGIN_FIXTURE_INPUTS).toContain(
      "$TURBO_ROOT$/scripts/lint-oxlint-fixtures.sh",
    );
    expect(PLUGIN_FIXTURE_INPUTS).toContain(
      "$TURBO_ROOT$/scripts/oxlint-safe-fixers.test.ts",
    );
  });

  test("plugin fixtures cover every dependency-resolution input", () => {
    for (const input of DEPENDENCY_CACHE_INPUTS) {
      expect(PLUGIN_FIXTURE_INPUTS).toContain(input);
    }
  });

  test("plugin fixtures cover every shared compiler input", () => {
    for (const input of SHARED_COMPILER_CACHE_INPUTS) {
      expect(PLUGIN_FIXTURE_INPUTS).toContain(input);
    }
  });

  test("plugin fixtures cover the root config discovered by Oxc", () => {
    expect(PLUGIN_FIXTURE_INPUTS).toContain("$TURBO_ROOT$/tsconfig.json");
  });

  test("root script lint covers every shared workspace input", () => {
    for (const input of ALL_WORKSPACE_CACHE_INPUTS) {
      expect(ROOT_SCRIPT_LINT_INPUTS).toContain(input);
    }
  });

  test("workspace typechecks cover every typecheck-only input", () => {
    expect(TYPECHECK_ONLY_CACHE_INPUTS).toContain(
      "$TURBO_ROOT$/packages/scripts/src/tsc-native.ts",
    );
    for (const input of TYPECHECK_ONLY_CACHE_INPUTS) {
      expect(ALL_WORKSPACE_TYPECHECK_CACHE_INPUTS).toContain(input);
    }
  });

  test("workspace lint covers the shared tooling config", () => {
    expect(LINT_ONLY_CACHE_INPUTS).toContain(
      "$TURBO_ROOT$/tsconfig.tooling.json",
    );
  });

  test("keeps planner-wide inputs exactly aligned with their Turbo tasks", () => {
    const tasks = turboTasks();

    expect(taskInputs(tasks, "typecheck").filter(isRootInput)).toEqual(
      [...ALL_WORKSPACE_TYPECHECK_CACHE_INPUTS].toSorted(),
    );
    expect(taskInputs(tasks, "//#typecheck:repo").filter(isRootInput)).toEqual(
      [
        "$TURBO_ROOT$/.claude/mcp/**",
        "$TURBO_ROOT$/.npmrc",
        "$TURBO_ROOT$/.oxlint-plugins/**",
        "$TURBO_ROOT$/apps/**",
        "$TURBO_ROOT$/bun.lock",
        "$TURBO_ROOT$/bunfig.toml",
        "$TURBO_ROOT$/oxlint.config.ts",
        "$TURBO_ROOT$/package.json",
        "$TURBO_ROOT$/packages/**",
        "$TURBO_ROOT$/patches/**",
        "$TURBO_ROOT$/scripts/**",
        "$TURBO_ROOT$/tsconfig*.json",
        "$TURBO_ROOT$/types/**",
      ].toSorted(),
    );
    expect(taskInputs(tasks, "lint").filter(isRootInput)).toEqual(
      [...ALL_WORKSPACE_CACHE_INPUTS, ...LINT_ONLY_CACHE_INPUTS].toSorted(),
    );
  });
});

describe("full and affected code-check parity", () => {
  test("an unexpected merge-base failure is surfaced, not read as no base", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "code-check-git-"));
    const git = Bun.which("git");
    expect(git).not.toBeNull();
    writeFileSync(
      path.join(directory, "git"),
      `#!/usr/bin/env bun
import { childExitStatus } from ${JSON.stringify(path.join(import.meta.dir, "../packages/scripts/src/child-exit-status.ts"))};
if (process.argv[2] === "rev-parse" && process.argv.at(-1) === "origin/main^{commit}") process.exit(0);
if (process.argv[2] === "merge-base") {
  process.stderr.write("fatal: injected failure\\n");
  process.exit(128);
}
const result = Bun.spawnSync([${JSON.stringify(git)}, ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });
process.exit(childExitStatus(result));
`,
      { mode: 0o755 },
    );
    try {
      const environmentPath = process.env["PATH"];
      if (environmentPath === undefined) {
        throw new Error("PATH is required to run the code-check command");
      }
      const result = Bun.spawnSync(
        ["bun", "scripts/code-check-affected.ts", "--all", "--dry-run"],
        { env: { ...process.env, PATH: `${directory}:${environmentPath}` } },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "git merge-base origin/main HEAD failed: fatal: injected failure",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("the full command still plans normal checks without origin/main", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "code-check-git-"));
    const git = Bun.which("git");
    expect(git).not.toBeNull();
    writeFileSync(
      path.join(directory, "git"),
      `#!/usr/bin/env bun
import { childExitStatus } from ${JSON.stringify(path.join(import.meta.dir, "../packages/scripts/src/child-exit-status.ts"))};
if (process.argv[2] === "rev-parse" && process.argv.at(-1) === "origin/main^{commit}") process.exit(1);
const result = Bun.spawnSync([${JSON.stringify(git)}, ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });
process.exit(childExitStatus(result));
`,
      { mode: 0o755 },
    );
    try {
      const environmentPath = process.env["PATH"];
      if (environmentPath === undefined) {
        throw new Error("PATH is required to run the code-check command");
      }
      const result = Bun.spawnSync(
        ["bun", "scripts/code-check-affected.ts", "--all", "--dry-run"],
        { env: { ...process.env, PATH: `${directory}:${environmentPath}` } },
      );
      expect(result.exitCode).toBe(0);
      const output = result.stdout.toString();
      expect(output).toContain(
        "skipping exact result boundary lint; no merge base for origin/main",
      );
      expect(output).toContain("code-check: lint all; typecheck all");
      expect(output).toContain("turbo run lint typecheck");
      expect(output).not.toContain(
        "oxlint -c oxlint.result-boundary.config.ts",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("the full check lints untracked root source files", () => {
    const file = `.claude/mcp/code-check-untracked-${process.pid}.ts`;
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, "export const untracked = true;\n");
    try {
      const result = Bun.spawnSync([
        "bun",
        "scripts/code-check-affected.ts",
        "--all",
        "--dry-run",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(file);
    } finally {
      rmSync(file);
    }
  }, 30_000);

  // The full check and every affected run reach workspaces through the same
  // `lint` and `typecheck` tasks, so the workspace scripts are the pass list.
  test("every workspace lint runs the type-checking Oxlint pass", () => {
    const missing = workspaceManifests()
      .filter(({ scripts }) => {
        const lint = scripts["lint"] ?? "";
        return !lint.includes("--type-aware") || !lint.includes("--type-check");
      })
      .map(({ workspace }) => workspace);

    expect(missing).toEqual([]);
  });

  test("the full check schedules every root check from the tracked tree", () => {
    const tracked = Bun.spawnSync(["git", "ls-files", "-z"])
      .stdout.toString()
      .split("\0")
      .filter(Boolean);
    const workspaces = new Set(
      workspaceManifests().map(({ workspace }) => workspace),
    );

    const planned = planFullCheck({
      files: tracked,
      workspacePaths: workspaces,
    });

    expect(planned.rootLintPaths).toContain(".claude/mcp/server.ts");
    expect(scopedCommands(planned)).toContainEqual([
      "bun",
      "--bun",
      "turbo",
      "run",
      "lint",
      "typecheck",
      "--concurrency=2",
      "--continue=dependencies-successful",
    ]);
  });

  test("the full check fails loudly when a root check is unreachable", () => {
    expect(() =>
      planFullCheck({
        files: ["package.json"],
        workspacePaths: WORKSPACES,
      }),
    ).toThrow("full code-check skips root checks");
  });

  // A typecheck that generates declarations before compiling (`wxt prepare`,
  // `astro check`) leaves a type environment the type-checking lint must see:
  // lint runs after it, and the generated directory survives a cache hit.
  test("lint type-checks after any workspace typecheck that generates types", () => {
    const tasks = turboTasks();
    const typecheckOutputs = new Set(taskField(tasks, "typecheck", "outputs"));
    const generating = workspaceManifests().filter(({ scripts }) => {
      const typecheck = scripts["typecheck"];
      return (
        typecheck
          ?.split("&&")
          .some((command) => !command.includes(TYPESCRIPT_NATIVE_RUNNER)) ??
        false
      );
    });

    // Non-vacuity: both known generators are detected.
    expect(generating.map(({ workspace }) => workspace)).toEqual(
      expect.arrayContaining(["apps/extension", "apps/landing"]),
    );
    for (const { name } of generating) {
      const producers = taskField(
        tasks,
        `${name}#typecheck`,
        "dependsOn",
      ).filter((dependency) => dependency.startsWith("generate:"));
      if (producers.length > 0) {
        // A dedicated cached producer owns the artifact; both compiler tasks
        // await it instead of making lint await the entire typecheck.
        expect(taskField(tasks, `${name}#lint`, "dependsOn")).toEqual(
          expect.arrayContaining(producers),
        );
        for (const producer of producers) {
          expect(
            taskField(tasks, `${name}#${producer}`, "outputs").length,
          ).toBeGreaterThan(0);
        }
        continue;
      }
      expect(taskField(tasks, `${name}#lint`, "dependsOn")).toEqual([
        "typecheck",
      ]);
      expect(taskInputs(tasks, `${name}#lint`)).toEqual(
        taskInputs(tasks, "lint"),
      );
      expect(taskInputs(tasks, `${name}#typecheck`)).toEqual(
        taskInputs(tasks, "typecheck"),
      );
      expect(
        taskField(tasks, `${name}#typecheck`, "outputs").filter(
          (output) => !typecheckOutputs.has(output),
        ),
      ).not.toEqual([]);
    }
  });

  test("landing generates Astro types once, in its typecheck", () => {
    const landing = workspaceManifests().find(
      ({ workspace }) => workspace === "apps/landing",
    );
    expect(landing?.scripts["lint"]).not.toContain("astro sync");
  });
});

const TYPESCRIPT_NATIVE_RUNNER = "scripts/src/tsc-native.ts";

type TurboTask = Record<string, unknown>;

const isStringRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const turboTasks = (): Record<string, TurboTask> => {
  const parsed: unknown = Bun.JSONC.parse(readFileSync("turbo.json", "utf-8"));
  if (!isStringRecord(parsed) || !isStringRecord(parsed["tasks"])) {
    throw new Error("turbo.json has no tasks object");
  }
  const tasks: Record<string, TurboTask> = {};
  for (const [name, task] of Object.entries(parsed["tasks"])) {
    if (!isStringRecord(task)) {
      throw new Error(`turbo.json task ${name} is not an object`);
    }
    tasks[name] = task;
  }
  return tasks;
};

const taskField = (
  tasks: Record<string, TurboTask>,
  name: string,
  field: "dependsOn" | "inputs" | "outputs",
): string[] => {
  const value = tasks[name]?.[field];
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`turbo.json task ${name} has no ${field} list`);
  }
  return value;
};

const taskInputs = (tasks: Record<string, TurboTask>, name: string) =>
  taskField(tasks, name, "inputs").toSorted();

const isRootInput = (input: string) => input.startsWith("$TURBO_ROOT$/");

type WorkspaceManifest = {
  workspace: string;
  name: string;
  scripts: Record<string, string | undefined>;
};

const workspaceManifests = (): WorkspaceManifest[] =>
  ["apps", "packages"].flatMap((parent) =>
    readdirSync(parent, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(path.join(parent, entry.name, "package.json")),
      )
      .map((entry) => {
        const workspace = `${parent}/${entry.name}`;
        const manifest: {
          name: string;
          scripts?: Record<string, string | undefined>;
        } = JSON.parse(
          readFileSync(path.join(workspace, "package.json"), "utf-8"),
        );
        return {
          workspace,
          name: manifest.name,
          scripts: manifest.scripts ?? {},
        };
      }),
  );

describe("parallel code-quality legs", () => {
  test("runs result consumption with the same plan scope and owner in every leg", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf-8");
    for (const leg of CODE_CHECK_LEGS) {
      const start = workflow.indexOf(`\n  code-quality-${leg}:\n`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextJob = workflow
        .slice(start + 1)
        .search(/\n {2}[a-z][a-z0-9-]*:\n/u);
      const job =
        nextJob === -1
          ? workflow.slice(start)
          : workflow.slice(start, start + 1 + nextJob);
      expect(job.match(/- name: Result consumption/gu)).toHaveLength(1);
      expect(job).toContain(
        `bun run check:result-consumption -- --all --leg ${leg}`,
      );
      expect(job).toContain(
        `bun run check:result-consumption -- --base "origin/$BASE_REF" --leg ${leg}`,
      );
    }
  });

  test("partition the unsplit workspace tasks and root commands at every scope", () => {
    const manifests = workspaceManifests();
    const scriptsByWorkspace = new Map(
      manifests.map(({ workspace, scripts }) => [workspace, scripts]),
    );
    const workspaces = new Set([
      ...manifests.map(({ workspace }) => workspace),
      ...WORKSPACES,
      "packages/new-workspace",
    ]);
    const plans = [
      plan(["bun.lock"], [...WORKSPACES]),
      plan(["apps/web/src/new.ts"], ["apps/web", "packages/ui"]),
      plan(["scripts/new.ts"], []),
    ];
    for (const planned of plans) {
      if (planned.type !== "scoped") {
        throw new TypeError("fixture must produce a scoped plan");
      }
      const expand = (commands: string[][]) =>
        commands.flatMap((command) => {
          if (command[2] !== "turbo" || command.includes("typecheck:repo")) {
            return [command.join(" ")];
          }
          const tasks = command.filter(
            (arg) => arg === "lint" || arg === "typecheck",
          );
          const included = command
            .filter((arg) => arg.startsWith("--filter=./"))
            .map((arg) => arg.slice("--filter=./".length));
          const excluded = new Set(
            command
              .filter((arg) => arg.startsWith("--filter=!./"))
              .map((arg) => arg.slice("--filter=!./".length)),
          );
          return [...workspaces]
            .filter(
              (workspace) =>
                (included.length === 0 || included.includes(workspace)) &&
                !excluded.has(workspace),
            )
            .flatMap((workspace) =>
              tasks
                .filter(
                  (task) =>
                    !scriptsByWorkspace.has(workspace) ||
                    typeof scriptsByWorkspace.get(workspace)?.[task] ===
                      "string",
                )
                .map((task) => `${workspace}#${task}`),
            );
        });
      const unsplit = expand(scopedCommands(planned));
      const split = CODE_CHECK_LEGS.flatMap((leg) =>
        expand(scopedCommands(planned, { leg, workspaces })),
      );
      expect(split.toSorted()).toEqual(unsplit.toSorted());
      expect(new Set(split).size).toBe(split.length);
    }
    expect(
      CODE_CHECK_LEGS.filter((leg) =>
        ownsCodeCheckPath("packages/new-workspace", leg),
      ),
    ).toEqual(["rest"]);
  });

  test("partition exact result-boundary lint paths including root sources", () => {
    const paths = [
      "apps/api/src/new.ts",
      "apps/web/src/new.ts",
      "packages/new/src/new.ts",
      "scripts/new.ts",
    ];
    for (const file of paths) {
      expect(
        CODE_CHECK_LEGS.filter((leg) => ownsCodeCheckPath(file, leg)),
      ).toHaveLength(1);
    }
  });
});

describe("check failure reporting", () => {
  const commands = [
    ["bun", "turbo", "lint"],
    ["bun", "turbo", "typecheck"],
    ["bun", "turbo", "typecheck:repo"],
  ];
  test("reports every failed command after executing the complete plan", async () => {
    const executed: (readonly string[])[] = [];
    const output: string[] = [];
    expect(
      await executeCheckCommands({
        commands,
        runner: async (command) => {
          expect(output).toEqual([]);
          executed.push(command);
          return command.includes("typecheck")
            ? Result.ok()
            : Result.err(
                new CommandFailedError({
                  message: "Check failed",
                  command,
                  exitCode: 2,
                  output: "check error",
                }),
              );
        },
        write: (line) => {
          output.push(line);
        },
      }),
    ).toBe(1);
    expect(executed).toEqual(commands);
    const report = output.join("");
    expect(report).toContain("code-check: 2 failed command(s)\n");
    expect(report).toContain("code-check: failed (exit 2): bun turbo lint");
    expect(report).toContain(
      "code-check: failed (exit 2): bun turbo typecheck:repo",
    );
    expect(report).not.toContain(
      "code-check: failed (exit 2): bun turbo typecheck\n",
    );
  });
  test("all successful commands and an empty plan exit zero without a failure summary", async () => {
    for (const successfulCommands of [commands, []]) {
      const executed: (readonly string[])[] = [];
      const output: string[] = [];
      expect(
        await executeCheckCommands({
          commands: successfulCommands,
          runner: (command) => {
            executed.push(command);
            return Result.ok();
          },
          write: (line) => {
            output.push(line);
          },
        }),
      ).toBe(0);
      expect(executed).toEqual(successfulCommands);
      expect(output).toEqual([]);
    }
  });
  test("dry runs show the same continuation flags without executing checks", async () => {
    const plannedCommands = scopedCommands({
      type: "scoped",
      lint: { type: "all" },
      typecheck: { type: "all" },
      rootLintPaths: [],
      rootChecks: ["repo-typecheck"],
    });
    const output: string[] = [];
    expect(
      await executeCheckCommands({
        commands: plannedCommands,
        dryRun: true,
        runner: () => {
          throw new Error("dry run executed a check");
        },
        write: (line) => {
          output.push(line);
        },
      }),
    ).toBe(0);
    expect(output.join("")).toBe(
      plannedCommands.map((command) => `  ${command.join(" ")}\n`).join(""),
    );
    expect(plannedCommands.length).toBeGreaterThan(0);
    for (const command of plannedCommands) {
      expect(command).toContain("--continue=dependencies-successful");
    }
  });
});

test("the CLI completes later checks, reports failures, and propagates its exit code", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "code-check-runner-"));
  const log = path.join(directory, "commands.log");
  const realGit = Bun.which("git");
  if (realGit === null) {
    throw new Error("CLI execution fixture requires Git");
  }
  writeFileSync(
    path.join(directory, "git"),
    `#!/bin/sh
if [ "$*" = 'rev-parse --verify --quiet origin/main^{commit}' ]; then
  exit 1
fi
exec "$CHECK_REAL_GIT" "$@"
`,
    { mode: 0o755 },
  );
  const fakeRunner = `#!/bin/sh
printf '%s\n' "$*" >> "$CHECK_COMMAND_LOG"
case "$CHECK_FAIL:$*" in
  yes:*"turbo run lint"*|yes:*"turbo run typecheck:repo"*) exit 2 ;;
esac
`;
  for (const executable of ["bun", "bash"]) {
    writeFileSync(path.join(directory, executable), fakeRunner, {
      mode: 0o755,
    });
  }
  try {
    for (const failure of ["yes", "no"]) {
      writeFileSync(log, "");
      const result = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          path.join(import.meta.dir, "code-check-affected.ts"),
          "--all",
          "--leg",
          "rest",
        ],
        {
          cwd: path.resolve(import.meta.dir, ".."),
          env: {
            ...process.env,
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
            CHECK_COMMAND_LOG: log,
            CHECK_REAL_GIT: realGit,
            CHECK_FAIL: failure,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = result.stdout.toString();
      const commands = readFileSync(log, "utf-8");
      expect(commands).toContain("turbo run lint typecheck");
      expect(commands).toContain("turbo run typecheck:repo");
      expect(result.exitCode, result.stderr.toString()).toBe(
        failure === "yes" ? 1 : 0,
      );
      if (failure === "yes") {
        expect(output).toContain("code-check: 2 failed command(s)");
        expect(output).toContain(
          "code-check: failed (exit 2): bun --bun turbo run lint typecheck",
        );
        expect(output).toContain(
          "code-check: failed (exit 2): bun --bun turbo run typecheck:repo",
        );
      } else {
        expect(output).not.toContain("failed command(s)");
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const TURBO_LINT_TYPECHECK = [
  "bun",
  "--bun",
  "turbo",
  "run",
  "lint",
  "typecheck",
  "--concurrency=2",
];

const failure = (command: readonly string[], lines: readonly string[]) =>
  new CommandFailedError({
    message: "Command failed (1)",
    command,
    exitCode: 1,
    output: lines.join("\n"),
  });

// Turbo 2 output shapes captured from real failing runs, with paths shortened.
const turboRunSummary = (task: string) => [
  `${task}:  ERROR  command (/repo/packages/errors) /tmp/bun run typecheck exited (1)`,
  "",
  " Tasks:    0 successful, 2 total",
  "Cached:    0 cached, 2 total",
  "  Time:    472ms ",
  `Failed:    ${task}`,
  "",
  " ERROR  run failed: command  exited (1)",
  'error: "turbo" exited with code 1',
];
const BUN_CACHE_STACK = [
  "Panic: Command failed (1): bun --bun turbo run lint typecheck",
  "      at panic (/home/runner/.bun/install/cache/better-result@3.0.1/dist/index.mjs:42:9)",
  "      at run (/repo/node_modules/better-result/dist/index.mjs:7:1)",
];

const expectNoStackFrames = (text: string) => {
  expect(text).not.toMatch(/^\s*at\s/mu);
  expect(text).not.toContain("node_modules");
  expect(text).not.toContain(".bun/install/cache");
};

describe("check failure summary", () => {
  test("a failed check never exits 0", () => {
    expect(failureExitCode(2)).toBe(2);
    expect(failureExitCode(128)).toBe(128);
    for (const code of [0, null, undefined, -1, 256, 1.5, Number.NaN]) {
      expect(failureExitCode(code)).toBe(1);
    }
  });

  test("names the failed Turbo task and its TypeScript errors from prefixed output", () => {
    const summary = summarizeCheckFailure(
      failure(TURBO_LINT_TYPECHECK, [
        "@stll/errors:lint: cache miss, executing c50df39634620efa",
        "@stll/errors:typecheck: $ bun ../../packages/scripts/src/tsc-native.ts --noEmit",
        "@stll/errors:typecheck: src/zz-broken.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
        '@stll/errors:typecheck: error: script "typecheck" exited with code 1',
        ...turboRunSummary("@stll/errors#typecheck"),
        ...BUN_CACHE_STACK,
      ]),
    );
    expect(summary.tasks).toEqual([
      {
        task: "@stll/errors#typecheck",
        errors: [
          "src/zz-broken.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
        ],
      },
    ]);
    expectNoStackFrames(formatCheckFailure({ summary, annotations: true }));
  });

  test("attributes grouped GitHub Actions output and reads tool annotations", () => {
    const summary = summarizeCheckFailure(
      failure(TURBO_LINT_TYPECHECK, [
        "::group::@stll/web:typecheck",
        "src/fine.ts(1,1): error TS2322: belongs to a passing task",
        "::endgroup::",
        "\u001B[;31m@stll/errors:lint\u001B[;0m",
        "$ cd ../.. && bun --bun oxlint -c oxlint.config.ts packages/errors",
        "::error file=packages/errors/src/zz-broken.ts,line=1,col=26,title=eslint(no-debugger)::packages/errors/src/zz-broken.ts:1:26: `debugger` statement is not allowed",
        "",
        "Found 0 warnings and 1 error.",
        'error: "oxlint" exited with code 1',
        "::error::command (/repo/packages/errors) /tmp/bun run lint exited (1)",
        ...turboRunSummary("@stll/errors#lint"),
      ]),
    );
    expect(summary.tasks).toEqual([
      {
        task: "@stll/errors#lint",
        errors: [
          "eslint(no-debugger): packages/errors/src/zz-broken.ts:1:26: `debugger` statement is not allowed",
          "Found 0 warnings and 1 error.",
        ],
      },
    ]);
    const formatted = formatCheckFailure({ summary, annotations: true });
    expect(formatted).toContain(
      "::error title=code-check%3A @stll/errors#lint failed::eslint(no-debugger): packages/errors/src/zz-broken.ts:1:26: `debugger` statement is not allowed%0AFound 0 warnings and 1 error.",
    );
    expect(formatCheckFailure({ summary, annotations: false })).not.toContain(
      "::error",
    );
  });

  test("keeps oxlint's diagnostic and location for each failed task", () => {
    const summary = summarizeCheckFailure(
      failure(TURBO_LINT_TYPECHECK, [
        "@stll/errors:lint:   x eslint(no-debugger): `debugger` statement is not allowed",
        "@stll/errors:lint:    ,-[packages/errors/src/zz-broken.ts:1:26]",
        "@stll/errors:lint:  1 | export const f = () => { debugger; };",
        "@stll/errors:lint: Found 0 warnings and 1 error.",
        "@stll/web:typecheck: src/a.ts(2,3): error TS2304: Cannot find name 'x'.",
        "Failed:    @stll/errors#lint, @stll/web#typecheck",
      ]),
    );
    expect(summary.tasks).toEqual([
      {
        task: "@stll/errors#lint",
        errors: [
          "x eslint(no-debugger): `debugger` statement is not allowed",
          ",-[packages/errors/src/zz-broken.ts:1:26]",
          "Found 0 warnings and 1 error.",
        ],
      },
      {
        task: "@stll/web#typecheck",
        errors: ["src/a.ts(2,3): error TS2304: Cannot find name 'x'."],
      },
    ]);
  });

  test("summarizes a non-Turbo command by its last lines without a stack", () => {
    const command = ["bun", "scripts/check-oxlint-plugin-registry.ts"];
    const summary = summarizeCheckFailure(
      failure(command, [
        "plugin registry: stella/no-foo is registered but has no fixture",
        ...BUN_CACHE_STACK,
      ]),
    );
    expect(summary.tasks).toEqual([
      {
        task: command.join(" "),
        errors: [
          "plugin registry: stella/no-foo is registered but has no fixture",
          "Panic: Command failed (1): bun --bun turbo run lint typecheck",
        ],
      },
    ]);
    const formatted = formatCheckFailure({ summary, annotations: true });
    expect(formatted).toContain(
      "code-check: failed (exit 1): bun scripts/check-oxlint-plugin-registry.ts",
    );
    expectNoStackFrames(formatted);
  });
});
