import { describe, expect, test } from "bun:test";

import { affectedCommands, planCheck } from "./code-check-affected";

const WORKSPACES = new Set([
  "apps/api",
  "apps/landing",
  "apps/web",
  "packages/errors",
  "packages/ui",
]);

const plan = (changedPaths: string[], affectedWorkspacePaths: string[]) =>
  planCheck({
    changedPaths,
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
      checkLanding: true,
    });
  });

  test("does not run workspace analysis for documentation-only changes", () => {
    expect(plan(["README.md"], [])).toEqual({
      type: "affected",
      targets: [],
      checkLanding: false,
    });
  });

  test("keeps lint and TypeScript diagnostics in one affected Oxc pass", () => {
    const commands = affectedCommands({
      type: "affected",
      targets: ["apps/web", "packages/ui"],
      checkLanding: false,
    });
    const oxc = commands.find((command) => command.includes("oxlint"));
    expect(oxc).toContain("--type-aware");
    expect(oxc).toContain("--type-check");
    expect(oxc?.slice(-2)).toEqual(["apps/web", "packages/ui"]);
  });

  test.each([
    "package.json",
    "bun.lock",
    "bunfig.toml",
    "turbo.json",
    "oxlint.config.ts",
    "tsconfig.json",
    ".oxlint-plugins/no-raw-use-effect.ts",
    "packages/typescript-config/base.json",
    "patches/vite.patch",
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
