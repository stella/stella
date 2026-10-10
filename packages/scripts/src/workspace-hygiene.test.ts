import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import repositoryPackage from "../../../package.json";
import { validateWorkspaceRoot } from "./workspace-hygiene";

// The temporary roots have no Git history; a pinned local environment keeps
// the app-boundary baseline out of these checks wherever the tests run.
const LOCAL = { env: {} };

let tempRoots: string[] = [];

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { force: true, recursive: true });
  }

  tempRoots = [];
});

describe("workspace hygiene", () => {
  test("rejects mirrored turbo install pins", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "2.10.3",
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
    mkdirSync(path.join(rootDir, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(rootDir, ".github/workflows/ci.yml"),
      "run: bun install -g turbo@2.9.18\n",
    );

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([
      {
        message:
          "turbo install version must derive from root package.json; found mirrored pin 2.10.3",
        path: "apps/web/Dockerfile:1",
      },
      {
        message:
          "turbo install version must derive from root package.json; found mirrored pin 2.9.18",
        path: ".github/workflows/ci.yml:1",
      },
    ]);
  });

  test("rejects bun --cwd <dir> run, which exits 0 without running", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "2.10.3",
        },
        scripts: { generate: "bun --cwd apps/web run generate:route-tree" },
      },
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
        scripts: { typecheck: "bun --cwd ../.. run generate && tsc" },
      },
    });

    mkdirSync(path.join(rootDir, "scripts"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "scripts/check.sh"),
      "set -e\nbun  --cwd\tapps/web run build\n",
    );
    mkdirSync(path.join(rootDir, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(rootDir, ".github/workflows/ci.yml"),
      "run: bun --cwd apps/web run test\n",
    );
    writeFileSync(
      path.join(rootDir, "apps/web/README.md"),
      "```sh\nbun --cwd apps/web run dev\n```\n",
    );

    const message =
      "`bun --cwd <dir> run <script>` exits 0 without running the script; use `bun run --cwd <dir> <script>`";
    expect(
      validateWorkspaceRoot(rootDir, LOCAL)
        .filter((issue) => issue.message === message)
        .map((issue) => issue.path)
        .toSorted(),
    ).toEqual([
      ".github/workflows/ci.yml:1",
      "apps/web/README.md:2",
      "apps/web/package.json:1",
      "package.json:1",
      "scripts/check.sh:2",
    ]);
  });

  test("accepts bun run --cwd and bun --cwd=<dir> run", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "2.10.3",
        },
        scripts: {
          generate: "bun run --cwd apps/web generate:route-tree",
          codegen: "bun --cwd=packages/cli run codegen:runtime",
          docs: "bun --cwd .claude/mcp test",
        },
      },
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("accepts turbo installs derived from the root package version", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/Dockerfile"),
      'RUN bun install -g "turbo@$(bun -p \'require("./package.json").devDependencies.turbo\')"\n',
    );

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("requires an exact root turbo version", () => {
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

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([
      {
        message:
          "root package.json must define devDependencies.turbo as an exact semver version",
        path: "package.json",
      },
    ]);
  });

  test("requires CSS package imports to be owned by the importing workspace", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "2.10.3",
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

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([
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
          turbo: "2.10.3",
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

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("requires workspaces to own the Bun types named by their tsconfig", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });

    writeFileSync(
      path.join(rootDir, "apps/web/tsconfig.json"),
      JSON.stringify({ compilerOptions: { types: ["bun-types"] } }),
    );

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message:
        "bun-types is named by this TypeScript project but is not declared in the workspace package.json",
      path: "apps/web/tsconfig.json",
    });
  });

  test("rejects a stale workspace-local package that shadows an exact catalog pin", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        catalog: { "@stll/folio-core": "0.15.13" },
        devDependencies: { turbo: "2.10.3" },
      },
      webPackageJson: {
        dependencies: { "@stll/folio-core": "catalog:" },
        name: "@stll/web",
      },
    });
    const stalePackageDirectory = path.join(
      rootDir,
      "apps/web/node_modules/@stll/folio-core",
    );
    const hoistedPackageDirectory = path.join(
      rootDir,
      "node_modules/@stll/folio-core",
    );
    mkdirSync(hoistedPackageDirectory, { recursive: true });
    writeFileSync(
      path.join(hoistedPackageDirectory, "package.json"),
      JSON.stringify({ name: "@stll/folio-core", version: "0.15.13" }),
    );
    mkdirSync(stalePackageDirectory, { recursive: true });
    writeFileSync(
      path.join(stalePackageDirectory, "package.json"),
      JSON.stringify({ name: "@stll/folio-core", version: "0.15.12" }),
    );

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message:
        "@stll/folio-core resolves to 0.15.12, but catalog: requires 0.15.13; remove the stale nested install and reinstall",
      path: "apps/web/package.json",
    });
  });

  test("accepts the exact catalog version resolved by a workspace", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        catalog: { "@stll/folio-core": "0.15.13" },
        devDependencies: { turbo: "2.10.3" },
      },
      webPackageJson: {
        dependencies: { "@stll/folio-core": "catalog:" },
        name: "@stll/web",
      },
    });
    const packageDirectory = path.join(
      rootDir,
      "node_modules/@stll/folio-core",
    );
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      path.join(packageDirectory, "package.json"),
      JSON.stringify({ name: "@stll/folio-core", version: "0.15.13" }),
    );

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("ignores package imports inside CSS comments", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          turbo: "2.10.3",
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

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("accepts Babel 7 in the native mobile toolchain", () => {
    const rootDir = createWorkspaceRoot({
      mobilePackageJson: {
        devDependencies: { "@babel/core": "^7.29.0" },
        name: "@stll/mobile",
      },
      rootPackageJson: {
        devDependencies: { turbo: "2.10.3" },
      },
      webPackageJson: {
        dependencies: {},
        devDependencies: {},
        name: "@stll/web",
      },
    });

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("rejects Babel major drift in a runtime workspace", () => {
    const rootDir = createWorkspaceRoot({
      mobilePackageJson: {
        devDependencies: { "@babel/core": "^8.0.1" },
        name: "@stll/mobile",
      },
      rootPackageJson: {
        devDependencies: { turbo: "2.10.3" },
      },
      webPackageJson: {
        dependencies: {},
        devDependencies: {},
        name: "@stll/web",
      },
    });

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message:
        "@babel/core must declare major 7 for this runtime; found ^8.0.1",
      path: "apps/mobile/package.json",
    });
  });

  test("keeps caller catalog additions from overriding toolchain pins", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        catalog: {
          oxlint: "1.77.0",
          typescript: "5.9.3",
        },
        devDependencies: {
          turbo: "2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        devDependencies: {},
        name: "@stll/web",
      },
    });

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("rejects workspace scripts that shadow Bun's checker", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: { devDependencies: { turbo: "2.10.3" } },
      webPackageJson: {
        name: "@stll/web",
        scripts: {
          check: "echo success",
          typecheck: "bun check --no-pretty --all --project=tsconfig.json",
        },
      },
    });
    expect(validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message: "scripts.check shadows Bun's native checker; rename the script",
      path: "apps/web/package.json",
    });
  });

  test("rejects a stale centralized lint configuration", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          "@stll/oxlint-config": "0.6.0",
          turbo: "2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        devDependencies: {},
        name: "@stll/web",
      },
    });

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message:
        "devDependencies.@stll/oxlint-config must be 0.12.0; found 0.6.0",
      path: "package.json",
    });
  });

  test("rejects deprecated Oxc and non-Bun typecheck scripts", () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          "oxlint-tsgolint": "0.25.0",
          turbo: "2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        devDependencies: { typescript: "catalog:" },
        name: "@stll/web",
        scripts: { typecheck: "tsc --noEmit" },
      },
    });

    expect(validateWorkspaceRoot(rootDir, LOCAL)).toEqual(
      expect.arrayContaining([
        {
          message:
            "devDependencies.oxlint-tsgolint must be 7.0.2003; found 0.25.0",
          path: "package.json",
        },
        {
          message:
            "scripts.typecheck must use bun check --no-pretty --all --project=<tsconfig>; found tsc --noEmit",
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
      ...(isRecord(rootPackageJson["catalog"])
        ? rootPackageJson["catalog"]
        : {}),
      oxlint: repositoryPackage.catalog.oxlint,
      typescript: "6.0.3",
    },
    devDependencies: {
      "@stll/oxlint-config": "0.12.0",
      "@typescript/native": "npm:typescript@7.0.2",
      "oxlint-tsgolint": "7.0.2003",
      typescript: "catalog:",
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
      scripts: {
        typecheck:
          "bun --cwd=../../packages/cli run codegen:runtime && bun --bun astro check",
      },
    }),
  );
  writeFileSync(
    path.join(rootDir, "packages/scripts/package.json"),
    JSON.stringify({
      devDependencies: { typescript: "catalog:" },
      name: "@stll/scripts",
      scripts: {
        typecheck: "bun check --no-pretty --all --project=tsconfig.json",
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
