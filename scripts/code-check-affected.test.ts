import { describe, expect, test } from "bun:test";

import { affectedCommands, planCheck } from "./code-check-affected";
import { isChangedLintPath } from "./lint-paths";

const WORKSPACES = new Set([
  "apps/api",
  "apps/landing",
  "apps/web",
  "packages/errors",
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

describe("affected code-check planning", () => {
  test("checks complete changed workspaces and reverse dependants", () => {
    expect(
      plan(
        ["packages/ui/src/button.tsx"],
        ["packages/ui", "apps/web", "apps/landing"],
      ),
    ).toEqual({
      type: "affected",
      targets: ["apps/landing", "apps/web", "packages/ui"],
      rootLintPaths: [],
    });
  });

  test("does not run workspace analysis for documentation-only changes", () => {
    expect(plan(["README.md"], [])).toEqual({
      type: "affected",
      targets: [],
      rootLintPaths: [],
    });
  });

  test("caches lint and typecheck per affected workspace", () => {
    const commands = affectedCommands({
      type: "affected",
      targets: ["apps/web", "packages/ui"],
      rootLintPaths: [],
    });
    expect(commands).toContainEqual(["bun", "run", "env:check"]);
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
  });

  test("lints changed root scripts outside Turbo workspaces", () => {
    const commands = affectedCommands({
      type: "affected",
      targets: [],
      rootLintPaths: ["scripts/guard.ts"],
    });

    const oxc = commands.find((command) => command.includes("oxlint"));
    expect(oxc).toContain("--type-aware");
    expect(oxc?.at(-1)).toBe("scripts/guard.ts");
  });

  test("typechecks dependants without trying to lint a deleted source", () => {
    expect(plan(["packages/ui/src/removed.ts"], ["packages/ui"], [])).toEqual({
      type: "affected",
      targets: ["packages/ui"],
      rootLintPaths: [],
    });
  });

  test.each([
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "scripts/code-check-affected.ts",
    "scripts/lint-paths.ts",
    "scripts/lint-oxlint-fixtures.sh",
    "scripts/lint-root-scripts.sh",
    "scripts/tsconfig.json",
    "turbo.json",
    "oxlint.config.ts",
    "tsconfig.json",
    ".oxlint-plugins/no-raw-use-effect.ts",
    "packages/typescript-config/base.json",
    "patches/vite.patch",
    "types/react-css-properties.d.ts",
  ])("falls back to the full repository for global input %s", (changedPath) => {
    expect(plan([changedPath], [])).toEqual({ type: "full", changedPath });
  });

  test("falls back when Turbo omits the directly changed workspace", () => {
    expect(plan(["apps/api/src/server.ts"], ["apps/web"])).toEqual({
      type: "full",
      changedPath: "apps/api/src/server.ts",
    });
  });

  test("falls back for an unknown workspace directory", () => {
    expect(plan(["apps/unknown/src/main.ts"], [])).toEqual({
      type: "full",
      changedPath: "apps/unknown/src/main.ts",
    });
  });

  test("falls back when Turbo returns a non-workspace target", () => {
    expect(plan(["README.md"], ["tools/unknown"])).toEqual({
      type: "full",
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
