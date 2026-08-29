import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectAppBoundaryEdges,
  validateWorkspaceAppBoundaries,
} from "./workspace-app-boundaries";

let tempRoots: string[] = [];

setDefaultTimeout(30_000);

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { force: true, recursive: true });
  }
  tempRoots = [];
});

describe("workspace app boundaries", () => {
  test("detects app dependencies, source imports, path aliases, and includes", () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "apps/web", {
      dependencies: { "@stll/api": "workspace:*" },
      name: "@stll/web",
    });
    writePackage(rootDir, "apps/landing", { name: "@stll/landing" });
    writePackage(rootDir, "packages/shared", { name: "@stll/shared" });
    writeFileSync(
      path.join(rootDir, "apps/web/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          paths: {
            "@/*": ["./src/*"],
            "@/api/*": ["../api/src/*"],
            "@server/*": ["../api/src/*"],
          },
        },
        include: ["src", "../api/src"],
      }),
    );
    writeFileSync(
      path.join(rootDir, "apps/web/src/contracts.ts"),
      [
        'import type { API } from "@stll/api/types";',
        'export { serverValue } from "../../api/src/server-value";',
        'const lazy = import("@server/lazy");',
        'const required = require("@stll/api/required");',
        'import type { ChatMessage } from "@/api/handlers/chat/types";',
        "const stringLiteral = 'import(\"@stll/api/ignored\")';",
        '// export { ignored } from "../../api/src/ignored";',
      ].join("\n"),
    );
    writeFileSync(
      path.join(rootDir, "packages/shared/src/index.ts"),
      'export type { API } from "@stll/api/types";\n',
    );
    writeFileSync(
      path.join(rootDir, "apps/landing/src/page.astro"),
      '---\nimport type { API } from "@stll/api/types";\n---\n',
    );

    expect(validateWorkspaceAppBoundaries(rootDir)).toEqual(
      expect.arrayContaining([
        {
          message:
            "app workspace dependency @stll/api targets apps/api; shared code belongs in packages/*",
          path: "apps/web/package.json",
        },
        {
          message:
            "TypeScript path mapping @server/* -> ../api/src/* targets apps/api",
          path: "apps/web/tsconfig.json",
        },
        {
          message: "TypeScript include ../api/src targets apps/api",
          path: "apps/web/tsconfig.json",
        },
        {
          message:
            "source import @stll/api/types targets apps/api; import shared code from packages/*",
          path: "packages/shared/src/index.ts",
        },
        {
          message:
            "source import @stll/api/types targets apps/api; import shared code from packages/*",
          path: "apps/landing/src/page.astro",
        },
        {
          message:
            "source import @stll/api/types targets apps/api; import shared code from packages/*",
          path: "apps/web/src/contracts.ts",
        },
        {
          message:
            "source import ../../api/src/server-value targets apps/api; import shared code from packages/*",
          path: "apps/web/src/contracts.ts",
        },
        {
          message:
            "source import @server/lazy targets apps/api; import shared code from packages/*",
          path: "apps/web/src/contracts.ts",
        },
        {
          message:
            "source import @stll/api/required targets apps/api; import shared code from packages/*",
          path: "apps/web/src/contracts.ts",
        },
        {
          message:
            "source import @/api/handlers/chat/types targets apps/api; import shared code from packages/*",
          path: "apps/web/src/contracts.ts",
        },
      ]),
    );

    expect(
      collectAppBoundaryEdges(rootDir).some(
        ({ specifier }) => specifier === "@stll/api/ignored",
      ),
    ).toBe(false);
  });

  test("resolves inherited TypeScript paths and includes", () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "apps/web", { name: "@stll/web" });
    writeFileSync(
      path.join(rootDir, "apps/web/tsconfig.base.json"),
      JSON.stringify({
        compilerOptions: { paths: { "@server/*": ["../api/src/*"] } },
        include: ["src", "../api/src"],
      }),
    );
    writeFileSync(
      path.join(rootDir, "apps/web/tsconfig.json"),
      JSON.stringify({ extends: "./tsconfig.base.json" }),
    );

    expect(validateWorkspaceAppBoundaries(rootDir)).toEqual(
      expect.arrayContaining([
        {
          message:
            "TypeScript path mapping @server/* -> ../api/src/* targets apps/api",
          path: "apps/web/tsconfig.json",
        },
        {
          message: "TypeScript include ../api/src targets apps/api",
          path: "apps/web/tsconfig.json",
        },
      ]),
    );
  });

  test("fails closed on invalid TypeScript configuration", () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/web", { name: "@stll/web" });
    writeFileSync(
      path.join(rootDir, "apps/web/tsconfig.json"),
      JSON.stringify({ extends: "./missing.json" }),
    );

    expect(validateWorkspaceAppBoundaries(rootDir)).toEqual([
      {
        message: expect.stringContaining("invalid TypeScript configuration"),
        path: "apps/web/tsconfig.json",
      },
    ]);
  });

  test("uses Git's tracked, untracked, and ignored file set", () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "apps/web", { name: "@stll/web" });
    writeFileSync(
      path.join(rootDir, "apps/web/src/tracked.ts"),
      'import type { API } from "@stll/api/types";\n',
    );
    writeFileSync(
      path.join(rootDir, ".gitignore"),
      "apps/web/src/ignored.ts\n",
    );
    initializeGitRoot(rootDir);
    writeFileSync(
      path.join(rootDir, "apps/web/src/untracked.ts"),
      'import type { API } from "@stll/api/untracked";\n',
    );
    writeFileSync(
      path.join(rootDir, "apps/web/src/ignored.ts"),
      'import type { API } from "@stll/api/ignored";\n',
    );

    const edges = collectAppBoundaryEdges(rootDir);
    expect(edges.map(({ specifier }) => specifier)).toContain(
      "@stll/api/types",
    );
    expect(edges.map(({ specifier }) => specifier)).toContain(
      "@stll/api/untracked",
    );
    expect(edges.map(({ specifier }) => specifier)).not.toContain(
      "@stll/api/ignored",
    );
  });

  test("requires the exception ledger to equal the observed debt", () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "packages/shared", { name: "@stll/shared" });
    const sourcePath = path.join(rootDir, "packages/shared/src/index.ts");
    writeFileSync(sourcePath, 'export type { API } from "@stll/api/types";\n');
    const observed = collectAppBoundaryEdges(rootDir);
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      `${JSON.stringify(observed, null, 2)}\n`,
    );
    initializeGitRoot(rootDir);

    expect(validateWorkspaceAppBoundaries(rootDir)).toEqual([]);

    writeFileSync(sourcePath, "export {};\n");
    expect(validateWorkspaceAppBoundaries(rootDir)).toEqual([
      {
        message:
          "stale app-boundary exception; remove it now that the dependency no longer exists",
        path: "scripts/app-boundary-exceptions.json:packages/shared/src/index.ts -> @stll/api/types",
      },
    ]);
  });

  test("forbids adding an observed edge to the committed exception ledger", () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "packages/shared", { name: "@stll/shared" });
    writeFileSync(
      path.join(rootDir, "packages/shared/src/existing.ts"),
      'export type { API } from "@stll/api/existing";\n',
    );
    const baseline = collectAppBoundaryEdges(rootDir);
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      `${JSON.stringify(baseline, null, 2)}\n`,
    );
    initializeGitRoot(rootDir);

    writeFileSync(
      path.join(rootDir, "packages/shared/src/new-debt.ts"),
      'export type { API } from "@stll/api/new-debt";\n',
    );
    const grownLedger = collectAppBoundaryEdges(rootDir);
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      `${JSON.stringify(grownLedger, null, 2)}\n`,
    );

    expect(validateWorkspaceAppBoundaries(rootDir)).toEqual([
      {
        message:
          "new app-boundary exceptions are forbidden; the ledger may only shrink",
        path: "scripts/app-boundary-exceptions.json:packages/shared/src/new-debt.ts -> @stll/api/new-debt",
      },
    ]);
  });

  test("fails closed when the exception ledger is malformed", () => {
    const rootDir = createRoot();
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      "not json\n",
    );

    expect(validateWorkspaceAppBoundaries(rootDir)).toEqual([
      {
        message: "app-boundary ledger must contain valid JSON",
        path: "scripts/app-boundary-exceptions.json",
      },
    ]);
  });

  test("rejects duplicate and inexact exception entries", () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "packages/shared", { name: "@stll/shared" });
    writeFileSync(
      path.join(rootDir, "packages/shared/src/index.ts"),
      'export type { API } from "@stll/api/types";\n',
    );
    const [observed] = collectAppBoundaryEdges(rootDir);
    if (observed === undefined) {
      throw new Error("expected one app-boundary edge");
    }
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      JSON.stringify([observed, observed, { ...observed, reason: "extra" }]),
    );

    expect(validateWorkspaceAppBoundaries(rootDir)).toEqual([
      {
        message: "app-boundary exception must not be duplicated",
        path: "scripts/app-boundary-exceptions.json:2",
      },
      {
        message:
          "app-boundary exception must define a valid kind, source, specifier, and target",
        path: "scripts/app-boundary-exceptions.json:3",
      },
    ]);
  });
});

const createRoot = () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "stella-app-boundaries-"));
  tempRoots.push(rootDir);
  mkdirSync(path.join(rootDir, "apps"), { recursive: true });
  mkdirSync(path.join(rootDir, "packages"), { recursive: true });
  mkdirSync(path.join(rootDir, "scripts"), { recursive: true });
  return rootDir;
};

const writePackage = (
  rootDir: string,
  relativePath: string,
  packageJson: Record<string, unknown>,
) => {
  const packagePath = path.join(rootDir, relativePath);
  mkdirSync(path.join(packagePath, "src"), { recursive: true });
  writeFileSync(
    path.join(packagePath, "package.json"),
    JSON.stringify(packageJson),
  );
};

const initializeGitRoot = (rootDir: string) => {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: rootDir,
  });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], {
    cwd: rootDir,
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: rootDir });
  execFileSync("git", ["add", "--all"], { cwd: rootDir });
  execFileSync("git", ["commit", "--quiet", "--message", "baseline"], {
    cwd: rootDir,
  });
};
