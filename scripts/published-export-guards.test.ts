import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isExpectedPublishedExportResolution,
  isOwnDistLoadFailure,
  isPublishedTestArtifact,
} from "./published-export-guards";

describe("published export artifact guard", () => {
  test.each([
    "fixtures/board.tsx",
    "dist/fixtures/card.tsx",
    "dist/card.test.ts",
    "dist/card.spec.tsx",
    "dist/card.test.d.ts",
    "dist/card.spec.d.ts",
    "playwright.config.ts",
    "dist/playwright.config.ts",
    "dist/card.playwright.ts",
  ])("rejects %s", (file) => {
    expect(isPublishedTestArtifact(file)).toBe(true);
  });

  test.each(["dist/board.tsx", "dist/card.d.ts", "README.md"])(
    "allows %s",
    (file) => {
      expect(isPublishedTestArtifact(file)).toBe(false);
    },
  );
});

describe("published export resolution guard", () => {
  const packageDir = "/repo/packages/example";

  test("requires built modules to resolve under dist", () => {
    const entry = { import: "./dist/index.js" };

    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/dist/index.js",
      }),
    ).toBe(true);
    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/src/index.ts",
      }),
    ).toBe(false);
  });

  test("requires copied assets to resolve to their declared path", () => {
    const entry = "./capability-catalog.json";

    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/capability-catalog.json",
      }),
    ).toBe(true);
    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/dist/capability-catalog.json",
      }),
    ).toBe(false);
  });
});

describe("Node load failure attribution", () => {
  const distDir = "/repo/packages/example/dist";

  test("an extensionless relative import inside dist is the tarball's defect", () => {
    expect(
      isOwnDistLoadFailure({
        distDir,
        reason:
          "ERR_MODULE_NOT_FOUND: Cannot find module '/repo/packages/example/dist/thing' imported from /repo/packages/example/dist/index.js",
      }),
    ).toBe(true);
  });

  test("a workspace dependency still exported as source in-repo is not", () => {
    expect(
      isOwnDistLoadFailure({
        distDir,
        reason:
          'ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".tsx" for /repo/packages/ui/src/components/button.tsx',
      }),
    ).toBe(false);
  });

  test("a third-party directory import reached from dist is not", () => {
    expect(
      isOwnDistLoadFailure({
        distDir,
        reason:
          "ERR_UNSUPPORTED_DIR_IMPORT: Directory import '/repo/packages/example/node_modules/@vendor/pkg/element' is not supported resolving ES modules imported from /repo/packages/example/dist/kanban/drag-interactions.js",
      }),
    ).toBe(false);
  });

  test("a sibling directory that merely starts with `dist` is not", () => {
    expect(
      isOwnDistLoadFailure({
        distDir,
        reason:
          "ERR_MODULE_NOT_FOUND: Cannot find module '/repo/packages/example/dist-cache/thing' imported from /repo/packages/example/dist/index.js",
      }),
    ).toBe(false);
  });

  test("a Bun-targeted package importing `bun` from its own dist is not", () => {
    expect(
      isOwnDistLoadFailure({
        distDir,
        reason:
          "ERR_MODULE_NOT_FOUND: Cannot find package 'bun' imported from /repo/packages/example/dist/runtime.js",
      }),
    ).toBe(false);
  });
});

describe("published export guard without workspace consumers", () => {
  test("resolves root, subpath, and alias exports through package self-reference", async () => {
    const packageDir = mkdtempSync(path.join(tmpdir(), "published-exports-"));
    const manifest = JSON.stringify({
      name: "@stll/export-guard-fixture",
      version: "0.1.0",
      type: "module",
      exports: {
        ".": "./src/index.ts",
        "./feature": "./src/feature.ts",
        "./legacy/feature": "./src/feature.ts",
      },
      files: ["dist", "src", "README.md"],
      scripts: { build: "bun build.ts" },
    });
    try {
      await Bun.write(path.join(packageDir, "package.json"), manifest);
      await Bun.write(
        path.join(packageDir, "build.ts"),
        `
        for (const name of ["index", "feature"]) {
          await Bun.write("dist/" + name + ".js", "export const value = 1;");
          await Bun.write("dist/" + name + ".d.ts", "export declare const value = 1;");
        }
      `,
      );
      const proc = Bun.spawn({
        cmd: [
          process.execPath,
          path.join(import.meta.dir, "check-published-exports.ts"),
          packageDir,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect({ exitCode, stderr }).toMatchObject({ exitCode: 0 });
      expect(stdout).toContain(
        "3 exports resolve and ship; modules load from dist in Node",
      );
      expect(await Bun.file(path.join(packageDir, "package.json")).text()).toBe(
        manifest,
      );
    } finally {
      rmSync(packageDir, { recursive: true, force: true });
    }
  });
});
