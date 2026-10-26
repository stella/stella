import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
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
  cgroupMemoryLimitFiles,
  cgroupMounts,
  CODE_CHECK_EXECUTION_BUDGET_MS,
  codeCheckConcurrency,
  CommandFailedError,
  configuredCodeCheckConcurrency,
  DEPENDENCY_CACHE_INPUTS,
  discoverAffectedWorkspaces,
  executeCheckCommands,
  failureExitCode,
  formatCheckFailure,
  LINT_ONLY_CACHE_INPUTS,
  lintAllTrace,
  matchedLintAllInputs,
  memoryLimitBytes,
  planCheck,
  planFullCheck,
  planningCommandTimeout,
  planResultBoundaryLint,
  PLUGIN_FIXTURE_INPUTS,
  PLUGIN_REGISTRY_INPUTS,
  prioritizeWebLint,
  resultBoundaryLintCommand,
  ROOT_SCRIPT_LINT_INPUTS,
  scopedCommands,
  separateApiLintFromTypecheck,
  SHARED_COMPILER_CACHE_INPUTS,
  summarizeCheckFailure,
  WORKSPACE_TYPECHECK_CACHE_INPUTS,
} from "./code-check-affected";
import configuredBudgets from "./code-quality-task-budgets.json" with { type: "json" };
import { isChangedLintPath } from "./lint-paths";
import { rootScriptLintPaths } from "./root-script-lint";

// Subprocess runs that assert on the plan pin a large machine; the plan
// otherwise depends on the host's memory.
const LARGE_MACHINE = { CODE_CHECK_MEMORY_BYTES: String(64 * 1024 ** 3) };

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
    repositoryPaths: presentChangedPaths,
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

  test("names the matched shared input in the lint-all trace", () => {
    expect(lintAllTrace(["scripts/design-lint-baseline.json"])).toBe(
      "code-check: lint all shared inputs: $TURBO_ROOT$/scripts/design-lint-baseline.json\n",
    );
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

  test("skips measured debt, boundaries, tests, and unrelated source", () => {
    expect(
      resultBoundaryLintCommand(
        [
          "apps/api/src/handlers/case-law/ingestion/adapters/eu-ecj.ts",
          "apps/api/src/lib/document-processing-queue.ts",
          "apps/api/src/lib/document-processing-queue.test.ts",
          "packages/start-runtime/src/runtime.ts",
          "packages/ssr-testkit/src/assert-document.ts",
          "apps/web/src/server.ts",
          "apps/web/src/ssr-renderer.ts",
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
      "apps/web/src/ssr-renderer.ts",
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
      `--concurrency=${configuredCodeCheckConcurrency()}`,
      "--summarize",
      "--remote-cache-timeout=20",
      "--log-order=stream",
      "--log-prefix=task",
      "--filter=./apps/web",
      "--filter=./packages/ui",
    ]);
    expect(commands).toContainEqual([
      "bun",
      "--bun",
      "turbo",
      "run",
      "typecheck:repo",
      `--concurrency=${configuredCodeCheckConcurrency()}`,
      "--summarize",
      "--remote-cache-timeout=20",
      "--log-order=stream",
      "--log-prefix=task",
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

  test("runs the real type-aware lint only for changed root scripts", () => {
    const fixture = "scripts/code-check-affected-type-aware.fixture.ts";
    const unchanged = "scripts/generate-cloud-setup.test.ts";
    writeFileSync(
      fixture,
      [
        "const unsafe: unknown = {};\n",
        "console.log(`value: $",
        "{unsafe}`);\n",
      ].join(""),
    );
    try {
      expect(rootScriptLintPaths([unchanged, fixture])).toEqual([
        fixture,
        unchanged,
      ]);
      const planned = plan([fixture], []);
      if (planned.type !== "scoped") {
        throw new Error("Expected a scoped code-check plan");
      }
      const command = scopedCommands(planned).find((candidate) =>
        candidate.includes("oxlint"),
      );
      expect(command).toBeDefined();
      expect(command).toContain(fixture);
      expect(command).not.toContain(unchanged);
      const result = Bun.spawnSync(command ?? [], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(
        `${result.stdout.toString()}${result.stderr.toString()}`,
      ).toContain("Invalid type used in template literal expression");
    } finally {
      rmSync(fixture, { force: true });
    }
  }, 30_000);

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
    "bunfig.toml",
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

  test.each(["bun.lock", "package.json"])(
    "uses Turbo's affected dependency graph for %s",
    (changedPath) => {
      const planned = plan([changedPath], ["packages/ui"]);
      expect(planned).toMatchObject({
        type: "scoped",
        lint: { type: "targets", targets: ["packages/ui"] },
        typecheck: { type: "targets", targets: ["packages/ui"] },
      });
    },
  );

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
    "apps/api/drizzle/20261016000000_example/migration.sql",
    "apps/api/drizzle/20261016000000_example/cutover.sql",
    "apps/api/src/lib/db/status-tables.gen.ts",
  ])("keeps workspace-local lint input %s scoped to the API", (changedPath) => {
    const planned = plan([changedPath], ["apps/api"]);
    expect(planned.type).toBe("scoped");
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(planned.lint).toEqual({
      type: "targets",
      targets: ["apps/api"],
    });
  });

  test("a status-table change relints the plugin fixtures that read it", () => {
    const planned = plan(
      ["apps/api/src/lib/db/status-tables.gen.ts"],
      ["apps/api"],
    );
    expect(planned.type).toBe("scoped");
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(planned.rootChecks).toContain("plugin-fixtures");
  });

  test.each([
    "scripts/design-lint-baseline.json",
    "scripts/ownership/status-transition.ts",
  ])("retains cross-workspace lint input %s", (changedPath) => {
    const planned = plan([changedPath], []);
    expect(planned.type).toBe("scoped");
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    expect(planned.lint).toEqual({ type: "all" });
    expect(matchedLintAllInputs([changedPath])).toContain(
      changedPath === "scripts/design-lint-baseline.json"
        ? "$TURBO_ROOT$/scripts/design-lint-baseline.json"
        : "$TURBO_ROOT$/scripts/ownership/*.ts",
    );
  });

  test.each([
    ["scripts/check-oxlint-plugin-registry.ts", "plugin-registry"],
    ["scripts/lint-oxlint-fixtures.sh", "plugin-fixtures"],
    ["scripts/oxlint-safe-fixers.test.ts", "plugin-fixtures"],
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
      `--concurrency=${configuredCodeCheckConcurrency()}`,
      "--summarize",
      "--remote-cache-timeout=20",
      "--log-order=stream",
      "--log-prefix=task",
    ]);
    expect(commands).toContainEqual([
      "bun",
      "--bun",
      "turbo",
      "run",
      "typecheck",
      `--concurrency=${configuredCodeCheckConcurrency()}`,
      "--summarize",
      "--remote-cache-timeout=20",
      "--log-order=stream",
      "--log-prefix=task",
      "--filter=./apps/web",
    ]);
  });

  test("native emit runner changes stay scoped to their workspace checks", () => {
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
    expect(planned.typecheck).toEqual({
      type: "targets",
      targets: ["packages/scripts"],
    });
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
      `--concurrency=${configuredCodeCheckConcurrency()}`,
      "--summarize",
      "--remote-cache-timeout=20",
      "--log-order=stream",
      "--log-prefix=task",
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

  test.each(["bun.lock", "package.json"])(
    "root dependency change %s schedules root-script lint independently of workspaces",
    (changedPath) => {
      const planned = plan([changedPath], []);
      expect(planned.type).toBe("scoped");
      if (planned.type !== "scoped") {
        throw new Error("Expected a scoped root dependency check");
      }
      expect(scopedCommands(planned)).toContainEqual([
        "bash",
        "scripts/lint-root-scripts.sh",
      ]);
    },
  );

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

  test("root script lint covers full root dependencies and shared compiler inputs", () => {
    for (const input of [
      ...DEPENDENCY_CACHE_INPUTS,
      ...SHARED_COMPILER_CACHE_INPUTS,
    ]) {
      expect(ROOT_SCRIPT_LINT_INPUTS).toContain(input);
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
      [...WORKSPACE_TYPECHECK_CACHE_INPUTS].toSorted(),
    );
    expect(taskInputs(tasks, "//#typecheck:repo").filter(isRootInput)).toEqual(
      [
        "$TURBO_ROOT$/.claude/mcp/**",
        "$TURBO_ROOT$/.npmrc",
        "$TURBO_ROOT$/.oxlint-plugins/**",
        "$TURBO_ROOT$/apps/**",
        "$TURBO_ROOT$/bunfig.toml",
        "$TURBO_ROOT$/bun.lock",
        "$TURBO_ROOT$/package.json",
        "$TURBO_ROOT$/oxlint.config.ts",
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
  test("a stale Bun fingerprint fails before planning or replaying any cached checks", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "code-check-toolchain-"));
    writeFileSync(
      path.join(directory, "bun"),
      `#!/bin/sh
if [ "$1" = "scripts/generate-bun-toolchain.ts" ]; then
  echo 'drifted: scripts/bun-toolchain.gen.json' >&2
  exit 1
fi
exec "$CHECK_REAL_BUN" "$@"
`,
      { mode: 0o755 },
    );
    try {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "scripts/code-check-affected.ts",
          "--all",
          "--dry-run",
        ],
        {
          env: {
            ...process.env,
            ...LARGE_MACHINE,
            PATH: `${directory}:${process.env["PATH"] ?? ""}`,
            CHECK_REAL_BUN: process.execPath,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        "drifted: scripts/bun-toolchain.gen.json",
      );
      expect(result.stdout.toString()).not.toContain(
        "code-check: lint all; typecheck all",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

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
        {
          env: {
            ...process.env,
            ...LARGE_MACHINE,
            PATH: `${directory}:${environmentPath}`,
          },
        },
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "git merge-base origin/main HEAD failed: fatal: injected failure",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  test("a missing origin/main with exit 1 and no signal uses the full-check fallback", () => {
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
      const reference = Bun.spawnSync(
        ["git", "rev-parse", "--verify", "--quiet", "origin/main^{commit}"],
        {
          env: {
            ...process.env,
            ...LARGE_MACHINE,
            PATH: `${directory}:${environmentPath}`,
          },
        },
      );
      expect(reference.exitCode).toBe(1);
      expect(Boolean(reference.signalCode)).toBe(false);
      const result = Bun.spawnSync(
        ["bun", "scripts/code-check-affected.ts", "--all", "--dry-run"],
        {
          env: {
            ...process.env,
            ...LARGE_MACHINE,
            PATH: `${directory}:${environmentPath}`,
          },
        },
      );
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(result.stderr.toString()).not.toContain("Panic");
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
    const tracked = trackedFiles();
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
      `--concurrency=${configuredCodeCheckConcurrency()}`,
      "--summarize",
      "--remote-cache-timeout=20",
      "--log-order=stream",
      "--log-prefix=task",
    ]);
  });

  // A lint-wide input changes what the root lint reports for root sources the
  // pull request leaves untouched, so the affected check must lint the same
  // root paths as the full check, or the change passes and main goes red.
  test.each([
    "oxlint.config.ts",
    ".oxlint-plugins/test-timing.ts",
    "scripts/ownership.ts",
    "tsconfig.tooling.json",
    "bun.lock",
    "types/svg.d.ts",
  ])("a change to %s lints every root path the full check lints", (input) => {
    const tracked = trackedFiles();
    const workspaces = new Set(
      workspaceManifests().map(({ workspace }) => workspace),
    );
    const full = planFullCheck({ files: tracked, workspacePaths: workspaces });
    const affected = planCheck({
      changedPaths: [input],
      presentChangedPaths: [input],
      repositoryPaths: tracked,
      affectedWorkspacePaths: [],
      workspacePaths: workspaces,
    });
    if (affected.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }

    expect(full.rootLintPaths).toContain(
      ".claude/mcp/stella-docs-http.test.ts",
    );
    expect(affected.rootLintPaths).toEqual(full.rootLintPaths);
  });

  test("a root source change outside the lint-wide inputs lints only itself", () => {
    const planned = planCheck({
      changedPaths: [".claude/mcp/server.ts"],
      presentChangedPaths: [".claude/mcp/server.ts"],
      repositoryPaths: trackedFiles(),
      affectedWorkspacePaths: [],
      workspacePaths: WORKSPACES,
    });
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }

    expect(planned.rootLintPaths).toEqual([".claude/mcp/server.ts"]);
  });

  test("the full check fails loudly when a root check is unreachable", () => {
    expect(() =>
      planFullCheck({
        files: ["turbo.json"],
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
          .some((command) => !command.includes(BUN_TYPECHECK_COMMAND)) ?? false
      );
    });

    // Non-vacuity: both known generators are detected.
    expect(generating.map(({ workspace }) => workspace)).toEqual(
      expect.arrayContaining(["apps/extension", "apps/landing"]),
    );
    for (const { name } of generating) {
      const compilerTasks = taskField(
        tasks,
        `${name}#typecheck`,
        "dependsOn",
      ).filter((dependency) => dependency.startsWith("typecheck:"));
      if (compilerTasks.length > 0) {
        // An aggregate delegates compiler work and cache outputs to its children.
        const producers = new Set(
          compilerTasks.flatMap((compiler) =>
            taskField(tasks, `${name}#${compiler}`, "dependsOn").filter(
              (dependency) => dependency.startsWith("generate:"),
            ),
          ),
        );
        expect(producers.size).toBeGreaterThan(0);
        expect(taskField(tasks, `${name}#lint`, "dependsOn")).toEqual(
          expect.arrayContaining([...producers]),
        );
        expect(
          taskField(tasks, `${name}#typecheck:tests`, "dependsOn"),
        ).toContain("generate:typecheck-declarations");
        expect(
          taskField(
            tasks,
            `${name}#generate:typecheck-declarations`,
            "outputs",
          ),
        ).toContain(".cache/typecheck-declarations/**");
        for (const compiler of compilerTasks) {
          expect(
            taskField(tasks, `${name}#${compiler}`, "dependsOn"),
          ).toContain("generate:capability-runtime");
        }
        continue;
      }
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
        expect.arrayContaining(taskInputs(tasks, "lint")),
      );
      expect(taskInputs(tasks, `${name}#typecheck`)).toEqual(
        expect.arrayContaining(taskInputs(tasks, "typecheck")),
      );
      expect(
        taskField(tasks, `${name}#typecheck`, "outputs").filter(
          (output) => !typecheckOutputs.has(output),
        ),
      ).not.toEqual([]);
    }
  });

  test("API lint awaits generated sources while remaining independent of all typecheck tasks", () => {
    const tasks = turboTasks();
    const pending = ["@stll/api#lint"];
    const visited = new Set<string>();
    for (const id of pending) {
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      const taskName = tasks[id] ? id : (id.split("#")[1] ?? id);
      if (tasks[taskName]?.["dependsOn"] === undefined) {
        continue;
      }
      for (const dependency of taskField(tasks, taskName, "dependsOn")) {
        const owner = id.split("#").at(0);
        if (!owner) {
          panic(`Missing task owner: ${id}`);
        }
        const qualified = dependency.includes("#")
          ? dependency
          : `${owner}#${dependency.replace(/^\^/u, "")}`;
        expect(qualified).not.toMatch(/#typecheck(?:$|:)/u);
        pending.push(qualified);
      }
    }
    expect(taskField(tasks, "@stll/api#lint", "dependsOn")).toEqual([
      "@stll/cli#codegen:runtime",
      "generate:capability-runtime",
      "generate:typecheck-declarations",
    ]);
  });

  test("landing generates Astro types once, in its typecheck", () => {
    const landing = workspaceManifests().find(
      ({ workspace }) => workspace === "apps/landing",
    );
    expect(landing?.scripts["lint"]).not.toContain("astro sync");
  });
});

const BUN_TYPECHECK_COMMAND = "bun check --no-pretty --all --project=";

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

const trackedFiles = (): string[] =>
  Bun.spawnSync(["git", "ls-files", "-z"])
    .stdout.toString()
    .split("\0")
    .filter(Boolean);

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
  // A healthy run may take its whole warning budget, so a step never stops
  // before it; a stalled run must not hold the job, and with it a merge group,
  // until the job's own timeout.
  test("quality steps stop between their warning budget and their job timeout", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf-8");
    const pooledChecks = (job: string): Record<string, unknown>[] => {
      const manifest = `.github/ci-checks/${job}.yml`;
      if (!existsSync(manifest)) {
        return [];
      }
      const parsed: unknown = Bun.YAML.parse(readFileSync(manifest, "utf-8"));
      const checks =
        typeof parsed === "object" && parsed !== null && "checks" in parsed
          ? parsed.checks
          : undefined;
      return Array.isArray(checks)
        ? checks.filter(
            (check): check is Record<string, unknown> =>
              typeof check === "object" && check !== null,
          )
        : [];
    };
    const minutes = (text: string, indent: number) =>
      Number(
        new RegExp(`^ {${indent}}timeout-minutes: (\\d+)$`, "mu").exec(
          text,
        )?.[1] ?? Number.NaN,
      );
    for (const [job, names] of [
      ["code-quality-api", ["Code quality"]],
      ["code-quality-web-rest", ["Code quality (web)", "Code quality (rest)"]],
    ] as const) {
      const block =
        workflow.split(new RegExp(`\\n  ${job}:\\n`, "u")).at(1) ??
        panic(`Missing job ${job}`);
      const jobBlock = block.split(/\n {2}[\w-]+:\n/u).at(0) ?? block;
      const jobMinutes = minutes(jobBlock, 4);
      // A check moved into the job's check pool keeps its step fields there.
      const pool = pooledChecks(job);
      for (const name of names) {
        const step = jobBlock
          .split(/\n {6}- name: /u)
          .find((candidate) => candidate.startsWith(`${name}\n`));
        const pooled = pool.find((check) => check["name"] === name);
        const stepMinutes =
          step === undefined
            ? Number(
                pooled?.["timeout-minutes"] ?? panic(`Missing step ${name}`),
              )
            : minutes(step, 8);
        expect(stepMinutes * 60_000, name).toBeGreaterThanOrEqual(
          CODE_CHECK_EXECUTION_BUDGET_MS,
        );
        expect(stepMinutes, name).toBeLessThan(jobMinutes);
      }
    }
  });

  test("the warning budget follows the API parallel critical path and measured cold branches", () => {
    expect(turboTasks()["@stll/api#lint"]?.["dependsOn"]).not.toContain(
      "typecheck",
    );
    const criticalPath =
      Math.max(
        configuredBudgets.overrides["@stll/api#typecheck"],
        configuredBudgets.overrides["@stll/api#lint"],
      ) +
      configuredBudgets.defaultSeconds * 2;
    expect(CODE_CHECK_EXECUTION_BUDGET_MS).toBe((criticalPath + 60) * 1000);
    const coldBranch = Math.max(
      ...configuredBudgets.coldSamplesSeconds["@stll/api#typecheck"],
      ...configuredBudgets.coldSamplesSeconds["@stll/api#lint"],
    );
    expect(CODE_CHECK_EXECUTION_BUDGET_MS).toBeGreaterThan(
      (coldBranch * 2 + configuredBudgets.defaultSeconds * 2) * 1000,
    );
  });

  test("web lint starts first without duplicating it or selecting an unrelated workspace", () => {
    const command = [
      "bun",
      "--bun",
      "turbo",
      "run",
      "lint",
      "typecheck",
      "--summarize",
    ];
    const prioritized = prioritizeWebLint([command]);
    expect(prioritized).toHaveLength(2);
    expect(prioritized.at(0)).toContain("@stll/web#lint");
    expect(prioritized.at(0)).toContain("@stll/web#typecheck");
    expect(prioritized.at(1)).toContain("--filter=!./apps/web");
    for (const filter of ["--filter=!./apps/web", "--filter=./apps/api"]) {
      expect(prioritizeWebLint([[...command, filter]])).toEqual([
        [...command, filter],
      ]);
    }
    expect(codeCheckConcurrency(8 * 1024 ** 3)).toBe(2);
    expect(codeCheckConcurrency(12 * 1024 ** 3)).toBe(3);
  });

  test("a container memory limit below the machine's is the limit the checks get", () => {
    const GiB = 1024 ** 3;
    const reads = (files: Record<string, string>) => (file: string) =>
      files[file];
    // A cloud sandbox: 64 GiB host, 16 GiB cgroup v2 limit.
    expect(
      memoryLimitBytes({
        total: 64 * GiB,
        read: reads({ "/sys/fs/cgroup/memory.max": `${16 * GiB}\n` }),
        requested: "",
      }),
    ).toBe(16 * GiB);
    // cgroup v1 with no effective limit reports a huge number.
    expect(
      memoryLimitBytes({
        total: 32 * GiB,
        requested: "",
        read: reads({
          "/sys/fs/cgroup/memory.max": "max\n",
          "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
        }),
      }),
    ).toBe(32 * GiB);
    // No cgroup files (macOS) or an unreadable file keep the machine's.
    expect(
      memoryLimitBytes({
        total: 48 * GiB,
        read: () => undefined,
        requested: "",
      }),
    ).toBe(48 * GiB);
    expect(
      memoryLimitBytes({
        total: 48 * GiB,
        requested: "",
        read: () => {
          throw new Error("EACCES");
        },
      }),
    ).toBe(48 * GiB);
  });

  test("a 16 GiB machine plans the full check with typecheck before lint", () => {
    const result = Bun.spawnSync(
      ["bun", "scripts/code-check-affected.ts", "--all", "--dry-run"],
      {
        env: {
          ...process.env,
          CODE_CHECK_MEMORY_BYTES: String(16 * 1024 ** 3),
        },
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const output = result.stdout.toString();
    expect(output).not.toContain("turbo run lint typecheck");
    const typecheckAt = output.indexOf("turbo run typecheck --concurrency");
    const lintAt = output.indexOf("turbo run lint --concurrency");
    expect(typecheckAt).toBeGreaterThan(-1);
    expect(lintAt).toBeGreaterThan(typecheckAt);
  }, 30_000);

  test("a nested cgroup limit counts although the mount root reports max", () => {
    const GiB = 1024 ** 3;
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/user.slice/ci.scope/job\n",
      "/sys/fs/cgroup/memory.max": "max\n",
      "/sys/fs/cgroup/user.slice/memory.max": "max\n",
      "/sys/fs/cgroup/user.slice/ci.scope/memory.max": `${12 * GiB}\n`,
      "/sys/fs/cgroup/user.slice/ci.scope/job/memory.max": "max\n",
    };
    expect(
      memoryLimitBytes({
        total: 64 * GiB,
        read: (file) => files[file],
        requested: "",
      }),
    ).toBe(12 * GiB);
    expect(cgroupMemoryLimitFiles("4:cpu,memory:/docker/abc\n")).toEqual([
      "/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes",
      "/sys/fs/cgroup/memory/docker/memory.limit_in_bytes",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes",
      "/sys/fs/cgroup/memory.max",
    ]);
  });

  // A v1 memory controller can be mounted anywhere, combined with others,
  // and a container sees its own cgroup as the mount root.
  test("a cgroup v1 limit is found through the actual memory mount", () => {
    const GiB = 1024 ** 3;
    const mountinfo = [
      "30 25 0:26 / /sys/fs/cgroup/cpu,cpuacct rw - cgroup cgroup rw,cpu,cpuacct",
      "31 25 0:27 /docker/abc /mnt/cg/cpu,memory rw,nosuid - cgroup cgroup rw,cpu,memory",
    ].join("\n");
    expect(cgroupMounts(mountinfo)).toEqual([
      { version: 1, root: "/docker/abc", mountpoint: "/mnt/cg/cpu,memory" },
    ]);
    const files: Record<string, string> = {
      "/proc/self/cgroup": "4:cpu,memory:/docker/abc/job\n",
      "/proc/self/mountinfo": mountinfo,
      "/mnt/cg/cpu,memory/job/memory.limit_in_bytes": "9223372036854771712\n",
      "/mnt/cg/cpu,memory/memory.limit_in_bytes": `${10 * GiB}\n`,
    };
    expect(
      memoryLimitBytes({
        total: 64 * GiB,
        read: (file) => files[file],
        requested: "",
      }),
    ).toBe(10 * GiB);
    // The conventional path alone would have missed it.
    expect(
      memoryLimitBytes({
        total: 64 * GiB,
        read: (file) => (file === "/proc/self/mountinfo" ? "" : files[file]),
        requested: "",
      }),
    ).toBe(64 * GiB);
  });

  // A cgroup namespace reports `/` while the mount keeps the host root.
  test("a namespaced cgroup v1 limit is read at the mount root", () => {
    const GiB = 1024 ** 3;
    const files: Record<string, string> = {
      "/proc/self/cgroup": "4:cpu,memory:/\n",
      "/proc/self/mountinfo":
        "31 25 0:27 /docker/abc /mnt/cg/cpu,memory rw,nosuid - cgroup cgroup rw,cpu,memory",
      "/mnt/cg/cpu,memory/memory.limit_in_bytes": `${16 * GiB}\n`,
    };
    expect(
      memoryLimitBytes({
        total: 64 * GiB,
        read: (file) => files[file],
        requested: "",
      }),
    ).toBe(16 * GiB);
  });

  test("a namespaced child cgroup limit is read below the mount root", () => {
    const GiB = 1024 ** 3;
    const files: Record<string, string> = {
      "/proc/self/cgroup": "4:cpu,memory:/job\n",
      "/proc/self/mountinfo":
        "31 25 0:27 /docker/abc /mnt/cg/cpu,memory rw,nosuid - cgroup cgroup rw,cpu,memory",
      "/mnt/cg/cpu,memory/memory.limit_in_bytes": "9223372036854771712\n",
      "/mnt/cg/cpu,memory/job/memory.limit_in_bytes": `${16 * GiB}\n`,
    };
    expect(
      memoryLimitBytes({
        total: 64 * GiB,
        read: (file) => files[file],
        requested: "",
      }),
    ).toBe(16 * GiB);
  });

  test("an explicit memory size replaces detection", () => {
    expect(
      memoryLimitBytes({ total: 8, read: () => "4", requested: "64" }),
    ).toBe(64);
    for (const requested of ["0", "-1", "lots", ""]) {
      expect(memoryLimitBytes({ total: 8, read: () => "4", requested })).toBe(
        4,
      );
    }
  });

  test("below 24 GiB the API typecheck and type-aware API lint never run together", () => {
    const GiB = 1024 ** 3;
    const turbo = (...rest: string[]) => [
      "bun",
      "--bun",
      "turbo",
      "run",
      "lint",
      "typecheck",
      "--concurrency=3",
      ...rest,
    ];
    const typecheckOnly = (...rest: string[]) => [
      "bun",
      "--bun",
      "turbo",
      "run",
      "typecheck",
      "--concurrency=3",
      ...rest,
    ];
    const lintOnly = (...rest: string[]) => [
      "bun",
      "--bun",
      "turbo",
      "run",
      "lint",
      "--concurrency=3",
      ...rest,
    ];
    const css = ["bun", "run", "lint:css"];
    for (const scope of [
      [],
      ["--filter=./apps/api", "--filter=./packages/agent-input"],
    ]) {
      expect(
        separateApiLintFromTypecheck([css, turbo(...scope)], 16 * GiB),
      ).toEqual([css, typecheckOnly(...scope), lintOnly(...scope)]);
    }
    // Enough memory, or no API in the command: lint and typecheck overlap.
    expect(separateApiLintFromTypecheck([turbo()], 24 * GiB)).toEqual([
      turbo(),
    ]);
    for (const scope of [["--filter=./apps/web"], ["--filter=!./apps/api"]]) {
      expect(separateApiLintFromTypecheck([turbo(...scope)], 16 * GiB)).toEqual(
        [turbo(...scope)],
      );
    }
    // A command with only one of the two is already separate.
    expect(separateApiLintFromTypecheck([lintOnly()], 16 * GiB)).toEqual([
      lintOnly(),
    ]);
  });

  test("a requested concurrency lowers the task count; invalid requests keep the memory default", () => {
    expect(codeCheckConcurrency(12 * 1024 ** 3, "1")).toBe(1);
    expect(codeCheckConcurrency(8 * 1024 ** 3, "100")).toBe(2);
    for (const requested of ["0", "-1", "1.5", "many", ""]) {
      expect(codeCheckConcurrency(12 * 1024 ** 3, requested)).toBe(3);
    }
  });

  test("only the configured concurrency reads CODE_CHECK_CONCURRENCY", () => {
    const probe = Bun.spawnSync(
      [
        "bun",
        "-e",
        `const m = await import(${JSON.stringify(path.join(import.meta.dirname, "code-check-affected.ts"))});
console.log(m.configuredCodeCheckConcurrency(), m.codeCheckConcurrency(12 * 1024 ** 3));`,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, CODE_CHECK_CONCURRENCY: "1" },
      },
    );
    expect(probe.stdout.toString().trim()).toBe("1 3");
  });

  test("runs result consumption with the same plan scope and owner in every leg", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf-8");
    const jobs = new Map<string, string>();
    const assertLeg = (job: string, leg: string) => {
      expect(job).toContain(
        `bun run check:result-consumption -- --all --leg ${leg}`,
      );
      expect(job).toContain(
        `bun run check:result-consumption -- --base "origin/$BASE_REF" --leg ${leg}`,
      );
    };
    for (const leg of CODE_CHECK_LEGS) {
      const jobId =
        leg === "api" ? "code-quality-api" : "code-quality-web-rest";
      const start = workflow.indexOf(`\n  ${jobId}:\n`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextJob = workflow
        .slice(start + 1)
        .search(/\n {2}[a-z][a-z0-9-]*:\n/u);
      const job =
        nextJob === -1
          ? workflow.slice(start)
          : workflow.slice(start, start + 1 + nextJob);
      // Pooled checks run from the job's manifest, so it is part of the job.
      const manifest = `.github/ci-checks/${jobId}.yml`;
      const withPool = existsSync(manifest)
        ? `${job}\n${readFileSync(manifest, "utf-8")}`
        : job;
      jobs.set(jobId, withPool);
      assertLeg(withPool, leg);
    }
    expect(
      jobs.get("code-quality-api")?.match(/- name: Result consumption/gu),
    ).toHaveLength(1);
    expect(
      jobs.get("code-quality-web-rest")?.match(/- name: Result consumption/gu),
    ).toHaveLength(2);
    for (const leg of ["web", "rest"] as const) {
      const mutated = jobs
        .get("code-quality-web-rest")
        ?.replace(`bun run check:result-consumption -- --all --leg ${leg}`, "");
      expect(() => assertLeg(mutated ?? "", leg)).toThrow(
        `bun run check:result-consumption -- --all --leg ${leg}`,
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
          const explicitTasks = command.flatMap((argument) => {
            const [name, task] = argument.split("#");
            if (task !== "lint" && task !== "typecheck") {
              return [];
            }
            const manifest = manifests.find(
              (candidate) => candidate.name === name,
            );
            if (manifest === undefined) {
              throw new Error(`Unknown task owner in ${argument}`);
            }
            return [`${manifest.workspace}#${task}`];
          });
          const included = command
            .filter((arg) => arg.startsWith("--filter=./"))
            .map((arg) => arg.slice("--filter=./".length));
          const excluded = new Set(
            command
              .filter((arg) => arg.startsWith("--filter=!./"))
              .map((arg) => arg.slice("--filter=!./".length)),
          );
          return [
            ...explicitTasks,
            ...[...workspaces]
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
              ),
          ];
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
  test("planner deadlines retain measured headroom beyond the old fixed cap and respect the remaining leg budget", () => {
    const longest =
      Math.max(...configuredBudgets.planningPhaseUpperBoundsSeconds) * 1000;
    const cap = planningCommandTimeout();
    expect(cap).toBeGreaterThanOrEqual(longest * 2 + 30_000);
    expect(planningCommandTimeout(31_000)).toBe(31_000);
    expect(planningCommandTimeout(cap + 1000)).toBe(cap);
    expect(planningCommandTimeout(500)).toBe(500);
    expect(cap).toBeLessThan(CODE_CHECK_EXECUTION_BUDGET_MS);
  });

  test("affected workspace discovery falls back to full scope after a bounded planner hang", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "code-check-planner-hang-"),
    );
    const diagnostics: string[] = [];
    try {
      const result = await discoverAffectedWorkspaces({
        mergeBase: "fixture-base",
        cwd: directory,
        timeoutMs: 1000,
        stallMs: 1000,
        command: [
          process.execPath,
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        report: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      });
      expect(result.unwrap()).toEqual({
        type: "fallback",
        reason: "affected workspace planner stall",
      });
      const output = diagnostics.join("");
      expect(output).toContain("using full check scope");
      expect(output).toContain("budget=1000ms");
      expect(output).toContain("elapsed=");
      expect(output).toContain("Command process tree at SIGTERM");
      expect(output).toContain("Command process tree at SIGKILL");
      expect(output).toContain("PID PPID PGID STATE COMMAND");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("affected workspace discovery preserves a fast planner scope and genuine failures", async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "code-check-planner-fast-"),
    );
    const diagnostics: string[] = [];
    try {
      const result = await discoverAffectedWorkspaces({
        mergeBase: "fixture-base",
        cwd: directory,
        timeoutMs: 1000,
        stallMs: 1000,
        command: [
          process.execPath,
          "-e",
          "console.log(JSON.stringify({packages:{items:[{path:'apps/web'}]}}))",
        ],
        report: (diagnostic) => {
          diagnostics.push(diagnostic);
        },
      });
      expect(result.unwrap()).toEqual({ type: "scoped", paths: ["apps/web"] });
      expect(diagnostics.join("")).toContain("outcome=completed");
      expect(diagnostics.join("")).not.toContain("using full check scope");
      const failed = await discoverAffectedWorkspaces({
        mergeBase: "fixture-base",
        cwd: directory,
        timeoutMs: 1000,
        stallMs: 1000,
        command: [process.execPath, "-e", "process.exit(7)"],
        report: () => {},
      });
      expect(failed.isErr()).toBe(true);
      if (failed.isErr()) {
        expect(failed.error.exitCode).toBe(7);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("sequential checks continue after their shared warning budget", async () => {
    let clock = 1000;
    const budgets: number[] = [];
    const output: string[] = [];
    expect(
      await executeCheckCommands({
        commands,
        now: () => clock,
        budgetDeadlineMs: 3000,
        runner: (_command, timeoutMs) => {
          budgets.push(timeoutMs);
          clock += 1500;
          return Result.ok();
        },
        write: (text) => {
          output.push(text);
        },
      }),
    ).toBe(0);
    expect(budgets).toEqual([2000, 500, 0]);
    expect(output.join("")).toContain(
      "execution warning budget exceeded; continuing checks",
    );
  });
  test("stops at the first failed command without retrying", async () => {
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
    expect(executed).toEqual(commands.slice(0, 1));
    const report = output.join("");
    expect(report).toContain("code-check: 1 failed command(s)\n");
    expect(report).toContain("code-check: failed (exit 2): bun turbo lint");
    expect(report).not.toContain(
      "code-check: failed (exit 2): bun turbo typecheck:repo",
    );
    expect(report).not.toContain(
      "code-check: failed (exit 2): bun turbo typecheck\n",
    );
  });
  test.each([{ args: [] }, { args: ["--leg", "api"] }])(
    "delegated full-check failures report the command without replaying task diagnostics (%j)",
    async ({ args }) => {
      const command = ["bun", "run", "code-check", ...args];
      const output: string[] = [];
      expect(
        await executeCheckCommands({
          commands: [command],
          runner: () =>
            Result.err(
              new CommandFailedError({
                message: "Nested check failed",
                command,
                exitCode: 2,
                output:
                  "Failed: @stll/api#lint\n::error::already reported\nerror TS2322: seeded nested error",
              }),
            ),
          write: (line) => {
            output.push(line);
          },
        }),
      ).toBe(1);
      expect(output.join(" ")).toContain(
        `delegated full check failed (exit 2): ${command.join(" ")}`,
      );
      expect(output.join(" ")).not.toContain("@stll/api#lint");
      expect(output.join(" ")).not.toContain("::error");
      expect(output.join(" ")).not.toContain("TS2322");
    },
  );

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
  test("dry runs request streaming task summaries without continuing or executing checks", async () => {
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
      expect(command).toContain("--summarize");
      expect(command).toContain("--log-order=stream");
      expect(command).not.toContain("--continue=dependencies-successful");
    }
  });
});

test("the CLI stops after failure, reports it, and propagates its exit code", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "code-check-runner-"));
  const fixtureRoot = path.join(directory, "repo");
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixturePackagesScripts = path.join(fixtureRoot, "packages/scripts/src");
  const log = path.join(directory, "commands.log");
  const realNodeModules = path.resolve(import.meta.dir, "../node_modules");
  const pathValue = process.env["PATH"];
  if (pathValue === undefined || !existsSync(realNodeModules)) {
    throw new Error(
      "CLI execution fixture requires PATH and installed modules",
    );
  }
  mkdirSync(path.join(fixtureRoot, "apps"), { recursive: true });
  mkdirSync(fixtureScripts, { recursive: true });
  mkdirSync(fixturePackagesScripts, { recursive: true });
  copyFileSync(
    path.join(import.meta.dir, "code-check-affected.ts"),
    path.join(fixtureScripts, "code-check-affected.ts"),
  );
  for (const helper of [
    "baseline-paths.ts",
    "check-rust-test-determinism.ts",
    "check-test-state-baseline.ts",
    "code-quality-task-budget.ts",
    "code-quality-task-budgets.json",
    "generated-files.ts",
    "ledger-membership.ts",
    "lint-paths.ts",
    "oxlint-config-scopes.ts",
    "ratchet.ts",
    "result-boundary-globs.ts",
    "root-script-lint.ts",
    "rust-test-determinism-scan.ts",
    "autofix-drift-checks.ts",
  ]) {
    symlinkSync(
      path.join(import.meta.dir, helper),
      path.join(fixtureScripts, helper),
    );
  }
  for (const helper of ["child-exit-status.ts", "code-quality-partition.ts"]) {
    symlinkSync(
      path.resolve(import.meta.dir, `../packages/scripts/src/${helper}`),
      path.join(fixturePackagesScripts, helper),
    );
  }
  symlinkSync(realNodeModules, path.join(fixtureRoot, "node_modules"));
  writeFileSync(
    path.join(fixtureRoot, ".gitignore"),
    [
      "*",
      "!.gitignore",
      "!turbo.json",
      "!scripts/",
      "scripts/*",
      "!oxlint.config.ts",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(fixtureRoot, "turbo.json"), '{"tasks":{}}\n');
  writeFileSync(path.join(fixtureRoot, "oxlint.config.ts"), "");
  const git = Bun.which("git");
  if (git === null) {
    throw new Error("CLI execution fixture requires Git");
  }
  for (const args of [
    ["init", "--quiet"],
    ["add", "turbo.json", "oxlint.config.ts"],
  ]) {
    const result = Bun.spawnSync([git, ...args], {
      cwd: fixtureRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
  }
  const fakeRunner = `#!/bin/sh
printf '%s\n' "$*" >> "$CHECK_COMMAND_LOG"
case "$CHECK_FAIL:$*" in
  yes:*"turbo run lint"*|yes:*"turbo run typecheck:repo"*) exit 2 ;;
esac
case "$*" in
  *"turbo run"*)
    mkdir -p .turbo/runs
    "$CHECK_REAL_BUN" --eval 'const fs = require("node:fs"); const file = ".turbo/runs/check-fixture-" + process.pid + ".json"; const now = Date.now(); fs.writeFileSync(file, JSON.stringify({version: "1", execution: {startTime: now, endTime: now, exitCode: 0}, tasks: []})); console.log("Summary: " + process.cwd() + "/" + file);'
    ;;
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
          path.join(fixtureScripts, "code-check-affected.ts"),
          "--all",
          "--leg",
          "rest",
        ],
        {
          cwd: fixtureRoot,
          env: {
            ...process.env,
            ...LARGE_MACHINE,
            PATH: `${directory}:${pathValue}`,
            CHECK_COMMAND_LOG: log,
            CHECK_REAL_BUN: process.execPath,
            CHECK_FAIL: failure,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = result.stdout.toString();
      expect(result.exitCode, result.stderr.toString()).toBe(
        failure === "yes" ? 1 : 0,
      );
      const commands = readFileSync(log, "utf-8");
      expect(
        commands,
        `CLI stdout:\n${output}\nCLI stderr:\n${result.stderr.toString()}`,
      ).toContain("turbo run lint typecheck");
      if (failure === "yes") {
        expect(commands).not.toContain("turbo run typecheck:repo");
      } else {
        expect(commands).toContain("turbo run typecheck:repo");
      }
      if (failure === "yes") {
        expect(output).toContain("code-check: 1 failed command(s)");
        expect(output).toContain(
          "code-check: failed (exit 2): bun --bun turbo run lint typecheck",
        );
        expect(output).not.toContain(
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
  `--concurrency=${configuredCodeCheckConcurrency()}`,
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
        "@stll/errors:typecheck: $ bun check --no-pretty --all --project=tsconfig.json",
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
