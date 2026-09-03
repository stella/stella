import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ALL_WORKSPACE_CACHE_INPUTS,
  ALL_WORKSPACE_TYPECHECK_CACHE_INPUTS,
  DEPENDENCY_CACHE_INPUTS,
  LINT_ONLY_CACHE_INPUTS,
  planCheck,
  PLUGIN_FIXTURE_INPUTS,
  PLUGIN_REGISTRY_INPUTS,
  ROOT_SCRIPT_LINT_INPUTS,
  SHARED_COMPILER_CACHE_INPUTS,
  TYPECHECK_ONLY_CACHE_INPUTS,
  resultBoundaryLintCommand,
  scopedCommands,
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
  test("enforces the exact Oxlint rules in legacy-debt directories", () => {
    expect(
      resultBoundaryLintCommand([
        "apps/api/src/lib/deepl/client.ts",
        "apps/api/src/lib/deepl/client.ts",
        "packages/boe/src/client.ts",
      ]),
    ).toEqual([
      "bun",
      "--bun",
      "oxlint",
      "-c",
      "oxlint.result-boundary.config.ts",
      "--deny-warnings",
      "apps/api/src/lib/deepl/client.ts",
      "packages/boe/src/client.ts",
    ]);
  });

  test("skips boundaries, generated output, tests, and unrelated source", () => {
    expect(
      resultBoundaryLintCommand([
        "apps/api/src/lib/document-processing-queue.ts",
        "apps/api/src/lib/document-processing-queue.test.ts",
        "apps/api/src/mcp/generated/capability-dispatch.ts",
        "apps/web/src/lib/example.ts",
      ]),
    ).toBeNull();
  });
});

describe("affected code-check planning", () => {
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
      rootChecks: ["env", "assets", "repo-typecheck"],
    });
  });

  test("does not run workspace analysis for documentation-only changes", () => {
    expect(plan(["README.md"], [])).toEqual({
      type: "scoped",
      lint: { type: "targets", targets: [] },
      typecheck: { type: "targets", targets: [] },
      rootLintPaths: [],
      rootChecks: ["env", "assets", "repo-typecheck"],
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
    ]);
  });

  test("lints changed root scripts outside Turbo workspaces", () => {
    const planned = plan(["scripts/guard.ts"], []);
    if (planned.type !== "scoped") {
      throw new Error("Expected a scoped code-check plan");
    }
    const commands = scopedCommands(planned);

    const oxc = commands.find((command) => command.includes("oxlint"));
    expect(oxc).toContain("--type-aware");
    expect(oxc?.at(-1)).toBe("scripts/guard.ts");
  });

  test("typechecks dependants without trying to lint a deleted source", () => {
    expect(plan(["packages/ui/src/removed.ts"], ["packages/ui"], [])).toEqual({
      type: "scoped",
      lint: { type: "targets", targets: ["packages/ui"] },
      typecheck: { type: "targets", targets: ["packages/ui"] },
      rootLintPaths: [],
      rootChecks: ["env", "assets", "repo-typecheck"],
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

  test.each(["oxlint.config.ts", ".oxlint-plugins/no-raw-use-effect.ts"])(
    "invalidates lint without discarding typecheck cache for %s",
    (changedPath) => {
      expect(plan([changedPath], [])).toEqual({
        type: "scoped",
        lint: { type: "all" },
        typecheck: { type: "targets", targets: [] },
        rootLintPaths: [changedPath],
        rootChecks: [
          "env",
          "assets",
          "plugin-registry",
          "plugin-fixtures",
          "root-script-lint",
          "repo-typecheck",
        ],
      });
    },
  );

  test("the shared tooling config invalidates only workspace lint", () => {
    expect(plan(["tsconfig.tooling.json"], [])).toEqual({
      type: "scoped",
      lint: { type: "all" },
      typecheck: { type: "targets", targets: [] },
      rootLintPaths: [],
      rootChecks: ["env", "assets", "repo-typecheck"],
    });
  });

  test.each([
    ["scripts/check-oxlint-plugin-registry.ts", "plugin-registry"],
    ["scripts/lint-oxlint-fixtures.sh", "plugin-fixtures"],
    ["scripts/oxlint-safe-fixers.test.ts", "plugin-fixtures"],
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
      expect(planned.rootChecks).toEqual([
        "env",
        "assets",
        rootCheck,
        "repo-typecheck",
      ]);
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
    ]);
    expect(commands).toContainEqual([
      "bun",
      "--bun",
      "turbo",
      "run",
      "typecheck",
      "--concurrency=2",
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
    ]);
  });

  test.each(
    ROOT_SCRIPT_LINT_INPUTS.map((input) =>
      input.slice("$TURBO_ROOT$/".length).replace(/\/\*\*$/u, "/fixture.ts"),
    ),
  )("shared root-script input %s schedules full root lint", (changedPath) => {
    const planned = plan([changedPath], []);
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
  ])("includes lintable source %s", (changedPath) => {
    expect(isChangedLintPath(changedPath)).toBe(true);
  });

  test.each([
    "README.md",
    "apps/web/src/routeTree.gen.ts",
    "apps/web/src/client.gen.mts",
    "apps/api/src/generated/schema.ts",
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

  test("landing generates Astro types once before type-aware lint", () => {
    const landingPackage = JSON.parse(
      readFileSync("apps/landing/package.json", "utf-8"),
    );
    expect(landingPackage.scripts.lint).not.toContain("astro sync");

    const turboConfig = readFileSync("turbo.json", "utf-8");
    const landingLintStart = turboConfig.indexOf('    "@stll/landing#lint":');
    const lintFixStart = turboConfig.indexOf('    "lint:fix":');
    expect(landingLintStart).toBeGreaterThan(-1);
    expect(lintFixStart).toBeGreaterThan(landingLintStart);
    const landingLintConfig = turboConfig.slice(landingLintStart, lintFixStart);
    expect(landingLintConfig).toContain('"dependsOn": ["typecheck"]');

    const rootInputs = [
      ...landingLintConfig.matchAll(/"(\$TURBO_ROOT\$\/[^"\n]+)"/gu),
    ]
      .map((match) => match.at(1))
      .filter((input) => input !== undefined)
      .sort();
    expect(rootInputs).toEqual(
      [...ALL_WORKSPACE_CACHE_INPUTS, ...LINT_ONLY_CACHE_INPUTS].sort(),
    );
  });

  test("landing's generated types survive a typecheck cache hit", () => {
    // Ordering alone does not deliver the types: `astro check` writes them,
    // and a task whose outputs are unrecorded replays its logs on a cache hit
    // and writes nothing. The dependent lint then reads `astro:content` as
    // `error` on any checkout that has not run the generator itself.
    const turboConfig = readFileSync("turbo.json", "utf-8");
    const landingTypecheckStart = turboConfig.indexOf(
      '    "@stll/landing#typecheck":',
    );
    expect(landingTypecheckStart).toBeGreaterThan(-1);
    const nextTaskStart = turboConfig.indexOf(
      '    "lint":',
      landingTypecheckStart,
    );
    expect(nextTaskStart).toBeGreaterThan(landingTypecheckStart);
    const landingTypecheckConfig = turboConfig.slice(
      landingTypecheckStart,
      nextTaskStart,
    );
    expect(landingTypecheckConfig).toContain('"outputs": [".astro/**"]');
  });

  test("keeps planner-wide inputs exactly aligned with their Turbo tasks", () => {
    const turboConfig = readFileSync("turbo.json", "utf-8");
    const typecheckStart = turboConfig.indexOf('    "typecheck":');
    const rootTypecheckStart = turboConfig.indexOf('    "//#typecheck:repo":');
    const lintStart = turboConfig.indexOf('    "lint":');
    const landingLintStart = turboConfig.indexOf('    "@stll/landing#lint":');
    const lintFixStart = turboConfig.indexOf('    "lint:fix":');
    expect(typecheckStart).toBeGreaterThan(-1);
    expect(rootTypecheckStart).toBeGreaterThan(typecheckStart);
    expect(lintStart).toBeGreaterThan(rootTypecheckStart);
    expect(landingLintStart).toBeGreaterThan(lintStart);
    expect(lintFixStart).toBeGreaterThan(landingLintStart);
    const typecheckConfig = turboConfig.slice(
      typecheckStart,
      rootTypecheckStart,
    );
    const rootTypecheckConfig = turboConfig.slice(
      rootTypecheckStart,
      lintStart,
    );
    const lintConfig = turboConfig.slice(lintStart, landingLintStart);
    const rootInputs = (taskConfig: string) =>
      [...taskConfig.matchAll(/"(\$TURBO_ROOT\$\/[^"\n]+)"/gu)]
        .map((match) => match.at(1))
        .filter((input) => input !== undefined)
        .sort();

    expect(rootInputs(typecheckConfig)).toEqual(
      [...ALL_WORKSPACE_TYPECHECK_CACHE_INPUTS].sort(),
    );
    expect(rootInputs(rootTypecheckConfig)).toEqual(
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
      ].sort(),
    );
    expect(rootInputs(lintConfig)).toEqual(
      [...ALL_WORKSPACE_CACHE_INPUTS, ...LINT_ONLY_CACHE_INPUTS].sort(),
    );
  });
});
