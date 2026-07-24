import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateWorkspaceRoot } from "./workspace-hygiene";

let tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { force: true, recursive: true });
  }

  tempRoots = [];
});

describe("workspace hygiene", () => {
  test("requires turbo install pins to match the root package version", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "^2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/Dockerfile"),
      "RUN bun install -g turbo@2.9.18\n",
    );
    mkdirSync(path.join(rootDir, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(rootDir, ".github/workflows/ci.yml"),
      "run: bun install -g turbo@2.9.18\n",
    );

    expect(validateWorkspaceRoot(rootDir)).toEqual([
      {
        message:
          "turbo install pin must match root package.json turbo 2.10.3; found 2.9.18",
        path: "apps/web/Dockerfile:1",
      },
      {
        message:
          "turbo install pin must match root package.json turbo 2.10.3; found 2.9.18",
        path: ".github/workflows/ci.yml:1",
      },
    ]);
  });

  test("accepts turbo install pins that match the root package version", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "^2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/Dockerfile"),
      "RUN bun install -g turbo@2.10.3\n",
    );

    expect(validateWorkspaceRoot(rootDir)).toEqual([]);
  });

  test("requires CSS package imports to be owned by the importing workspace", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "^2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/src/reader.css"),
      '@import "@fontsource-variable/source-serif-4";\n',
    );

    expect(validateWorkspaceRoot(rootDir)).toEqual([
      {
        message:
          "CSS import @fontsource-variable/source-serif-4 resolves to package @fontsource-variable/source-serif-4, but @fontsource-variable/source-serif-4 is not declared in this workspace package.json",
        path: "apps/web/src/reader.css:1",
      },
    ]);
  });

  test("accepts CSS package imports declared by the importing workspace", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "^2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {
          "@fontsource-variable/source-serif-4": "^5.2.9",
        },
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/src/reader.css"),
      '@import "@fontsource-variable/source-serif-4";\n',
    );

    expect(validateWorkspaceRoot(rootDir)).toEqual([]);
  });

  test("ignores package imports inside CSS comments", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "^2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/src/reader.css"),
      '/*\n@import "@fontsource-variable/source-serif-4";\n*/\n',
    );

    expect(validateWorkspaceRoot(rootDir)).toEqual([]);
  });

  test("accepts the deliberate Babel major split between native and web", () => {
    const rootDir = createWorkspaceRoot({
      mobilePackageJson: {
        devDependencies: { "@babel/core": "^7.29.0" },
        name: "@stll/mobile",
      },
      rootPackageJson: {
        devDependencies: { turbo: "^2.10.3" },
      },
      webPackageJson: {
        dependencies: {},
        devDependencies: { "@babel/core": "^8.0.1" },
        name: "@stll/web",
      },
    });

    expect(validateWorkspaceRoot(rootDir)).toEqual([]);
  });

  test("rejects Babel major drift in a runtime workspace", () => {
    const rootDir = createWorkspaceRoot({
      mobilePackageJson: {
        devDependencies: { "@babel/core": "^8.0.1" },
        name: "@stll/mobile",
      },
      rootPackageJson: {
        devDependencies: { turbo: "^2.10.3" },
      },
      webPackageJson: {
        dependencies: {},
        devDependencies: { "@babel/core": "^8.0.1" },
        name: "@stll/web",
      },
    });

    expect(validateWorkspaceRoot(rootDir)).toContainEqual({
      message:
        "@babel/core must declare major 7 for this runtime; found ^8.0.1",
      path: "apps/mobile/package.json",
    });
  });

  test("rejects deprecated Oxc and non-native TypeScript toolchains", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          "oxlint-tsgolint": "0.25.0",
          turbo: "^2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        devDependencies: { typescript: "catalog:" },
        name: "@stll/web",
        scripts: { typecheck: "tsc --noEmit" },
      },
    });

    expect(validateWorkspaceRoot(rootDir)).toEqual(
      expect.arrayContaining([
        {
          message:
            "devDependencies.oxlint-tsgolint must be 7.0.2001; found 0.25.0",
          path: "package.json",
        },
        {
          message:
            "scripts.typecheck must use the TypeScript 7 native wrapper; found tsc --noEmit",
          path: "apps/web/package.json",
        },
        {
          message:
            "TypeScript 6 is compatibility-only and may only be declared by packages/scripts for the compiler API",
          path: "apps/web/package.json",
        },
      ]),
    );
  });
});

type CreateWorkspaceRootOptions = {
  mobilePackageJson?: Record<string, unknown>;
  rootPackageJson: Record<string, unknown>;
  webPackageJson: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const createWorkspaceRoot = ({
  mobilePackageJson,
  rootPackageJson,
  webPackageJson,
}: CreateWorkspaceRootOptions) => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "stella-workspace-hygiene-"));
  tempRoots.push(rootDir);

  const rootDevDependencies = isRecord(rootPackageJson["devDependencies"])
    ? rootPackageJson["devDependencies"]
    : {};
  const validRootPackage = {
    ...rootPackageJson,
    catalog: {
      oxlint: "1.75.0",
      typescript: "6.0.3",
    },
    devDependencies: {
      "@stll/oxlint-config": "0.6.0",
      "@typescript/native": "npm:typescript@7.0.2",
      "oxlint-tsgolint": "7.0.2001",
      typescript: "catalog:",
      ultracite: "catalog:",
      ...rootDevDependencies,
    },
  };

  mkdirSync(path.join(rootDir, "apps/web/src"), { recursive: true });
  mkdirSync(path.join(rootDir, "apps/landing"), { recursive: true });
  mkdirSync(path.join(rootDir, "packages/scripts"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify(validRootPackage),
  );
  writeFileSync(
    path.join(rootDir, "apps/web/package.json"),
    JSON.stringify(webPackageJson),
  );
  writeFileSync(
    path.join(rootDir, "apps/landing/package.json"),
    JSON.stringify({
      devDependencies: { "@astrojs/check": "^0.9.9" },
      name: "@stll/landing",
      scripts: { typecheck: "bun --bun astro check" },
    }),
  );
  writeFileSync(
    path.join(rootDir, "packages/scripts/package.json"),
    JSON.stringify({
      devDependencies: { typescript: "catalog:" },
      name: "@stll/scripts",
      scripts: {
        typecheck: "bun ../../packages/scripts/src/tsc-native.ts --noEmit",
      },
    }),
  );

  if (mobilePackageJson) {
    mkdirSync(path.join(rootDir, "apps/mobile"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "apps/mobile/package.json"),
      JSON.stringify(mobilePackageJson),
    );
  }

  return rootDir;
};
