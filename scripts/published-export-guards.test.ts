import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  isExpectedPublishedExportResolution,
  isOwnDistLoadFailure,
  isPublishedTestArtifact,
  resolvePublishedExport,
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
    const entry = "./contract.json";

    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/contract.json",
      }),
    ).toBe(true);
    expect(
      isExpectedPublishedExportResolution({
        entry,
        packageDir,
        resolved: "/repo/packages/example/dist/contract.json",
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

describe("published export resolution precedence", () => {
  test("keeps the repoRoot result when the isolated consumer points elsewhere", async () => {
    const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "published-export-precedence-")),
    );
    const name = "@stll/export-precedence-fixture";
    const consumerDir = path.join(root, "consumer");
    const consumerPackageDir = path.join(consumerDir, "node_modules", name);
    const linkedDir = path.join(root, "node_modules", name);
    const manifest = JSON.stringify({
      name,
      type: "module",
      exports: { ".": "./entry.js" },
    });
    try {
      for (const directory of [consumerPackageDir, linkedDir]) {
        await Bun.write(path.join(directory, "package.json"), manifest);
        await Bun.write(
          path.join(directory, "entry.js"),
          "export const value = 1;",
        );
      }
      const fromConsumer = Bun.resolveSync(name, consumerDir);
      const fromRoot = Bun.resolveSync(name, root);
      expect(fromConsumer).toBe(path.join(consumerPackageDir, "entry.js"));
      expect(fromRoot).toBe(path.join(linkedDir, "entry.js"));
      expect(
        resolvePublishedExport({
          specifier: name,
          repoRoot: root,
          consumerDir,
        }),
      ).toBe(fromRoot);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
