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
  test("rejects alternate test runners and their types", async () => {
    const deniedNames = [
      "jest",
      "vitest",
      "mocha",
      "@types/jest",
      "@types/vitest",
      "@types/mocha",
    ];
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          ...Object.fromEntries(
            deniedNames
              .filter((name) => name !== "@types/mocha")
              .map((name) => [name, "1.0.0"]),
          ),
          "mocha-types": "npm:@types/mocha@1.0.0",
        },
      },
      webPackageJson: {
        dependencies: { "jest-compatible": "1.0.0" },
        devDependencies: { "vitest-utils": "1.0.0" },
        name: "@stll/web",
      },
    });

    expect(
      (await validateWorkspaceRoot(rootDir, LOCAL)).filter((issue) =>
        issue.message.endsWith(" is blocked; tests run on bun test"),
      ),
    ).toEqual(
      deniedNames.map((name) => ({
        message: `${name} is blocked; tests run on bun test`,
        path: "package.json",
      })),
    );
  });

  test("rejects exact npm text-search dependencies and accepts similar names", async () => {
    const deniedNames = [
      "fuse.js",
      "flexsearch",
      "minisearch",
      "lunr",
      "fast-levenshtein",
      "fastest-levenshtein",
      "leven",
      "js-levenshtein",
      "string-similarity",
      "ahocorasick",
      "natural",
      "match-sorter",
      "cmdk",
      "fuzzysort",
      "@leeoniya/ufuzzy",
      "fuzzball",
      "rapidfuzz",
      "fuzzywuzzy",
    ];
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          ...Object.fromEntries(
            deniedNames
              .filter((name) => name !== "@leeoniya/ufuzzy")
              .map((name) => [name, "1.0.0"]),
          ),
          "search-alias": "npm:@leeoniya/ufuzzy@1.0.0",
        },
      },
      webPackageJson: {
        dependencies: {
          "fuse-js": "1.0.0",
          "@leeoniya/ufuzzy-extra": "1.0.0",
        },
        devDependencies: { "flexsearch-lite": "1.0.0" },
        name: "@stll/web",
        optionalDependencies: { "cmdk-components": "1.0.0" },
        peerDependencies: { "lunr-pro": "1.0.0" },
      },
    });
    const mcpManifest = path.join(rootDir, ".claude/mcp/package.json");
    mkdirSync(path.dirname(mcpManifest), { recursive: true });
    writeFileSync(
      mcpManifest,
      JSON.stringify({
        dependencies: { fuzzywuzzy: "1.0.0" },
        name: "stella-docs-mcp",
      }),
    );

    expect(
      (await validateWorkspaceRoot(rootDir, LOCAL)).filter((issue) =>
        issue.message.includes(" is blocked; use @stll/text-search"),
      ),
    ).toEqual(
      [
        ...deniedNames.filter((name) => name !== "@leeoniya/ufuzzy"),
        "@leeoniya/ufuzzy",
      ]
        .map((name) => ({
          message: `${name} is blocked; use @stll/text-search for search functionality`,
          path: "package.json",
        }))
        .concat({
          message:
            "fuzzywuzzy is blocked; use @stll/text-search for search functionality",
          path: ".claude/mcp/package.json",
        }),
    );
  });

  test("rejects exact Cargo text-search dependencies across manifest tables", async () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {},
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });
    const manifestPath = path.join(rootDir, "apps/web/Cargo.toml");
    writeFileSync(
      manifestPath,
      [
        "[package]",
        'name = "fixture"',
        'version = "0.1.0"',
        "",
        "[workspace.dependencies]",
        'rapidfuzz = "0.1"',
        'strsim = "0.11"',
        "",
        "[dependencies]",
        'fuzzy = { package = "fuzzy-matcher", version = "0.3" }',
        "",
        "[dev-dependencies]",
        'levenshtein = "1.0"',
        "",
        "[build-dependencies]",
        'edit-distance = "2.0"',
        "",
        "[target.'cfg(target_os = \"linux\")'.dependencies]",
        'triple_accel = "0.4"',
      ].join("\n"),
    );

    expect(
      (await validateWorkspaceRoot(rootDir, LOCAL)).filter((issue) =>
        issue.message.includes(" is blocked; use @stll/text-search"),
      ),
    ).toEqual(
      [
        "fuzzy-matcher",
        "levenshtein",
        "edit-distance",
        "rapidfuzz",
        "strsim",
        "triple_accel",
      ].map((name) => ({
        message: `${name} is blocked; use @stll/text-search for search functionality`,
        path: "apps/web/Cargo.toml",
      })),
    );
  });

  test("accepts similar Cargo crate names and package rename targets", async () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {},
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });
    writeFileSync(
      path.join(rootDir, "packages/scripts/Cargo.toml"),
      [
        "[workspace.dependencies]",
        'strsim-extra = "0.11"',
        'similarity = { package = "levenshtein-rs", version = "1.0" }',
        "",
        "[target.'cfg(target_os = \"linux\")'.dev-dependencies]",
        'triple-accelerator = "0.4"',
      ].join("\n"),
    );

    expect(
      (await validateWorkspaceRoot(rootDir, LOCAL)).filter((issue) =>
        issue.message.includes(" is blocked; use @stll/text-search"),
      ),
    ).toEqual([]);
  });

  test("rejects mirrored turbo install pins", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([
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

  test("rejects bun --cwd <dir> run, which exits 0 without running", async () => {
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
      (await validateWorkspaceRoot(rootDir, LOCAL))
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

  test("accepts bun run --cwd and bun --cwd=<dir> run", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("accepts turbo installs derived from the root package version", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("requires an exact root turbo version", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([
      {
        message:
          "root package.json must define devDependencies.turbo as an exact semver version",
        path: "package.json",
      },
    ]);
  });

  test("requires CSS package imports to be owned by the importing workspace", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([
      {
        message:
          "CSS import @fontsource-variable/source-serif-4 resolves to package @fontsource-variable/source-serif-4, but @fontsource-variable/source-serif-4 is not declared in this workspace package.json",
        path: "apps/web/src/reader.css:1",
      },
    ]);
  });

  test("accepts CSS package imports declared by the importing workspace", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("requires workspaces to own the Bun types named by their tsconfig", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message:
        "bun-types is named by this TypeScript project but is not declared in the workspace package.json",
      path: "apps/web/tsconfig.json",
    });
  });

  test("rejects a stale workspace-local package that shadows an exact catalog pin", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message:
        "@stll/folio-core resolves to 0.15.12, but catalog: requires 0.15.13; remove the stale nested install and reinstall",
      path: "apps/web/package.json",
    });
  });

  test("accepts the exact catalog version resolved by a workspace", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("ignores package imports inside CSS comments", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("accepts Babel 7 in the native mobile toolchain", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("rejects Babel major drift in a runtime workspace", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message:
        "@babel/core must declare major 7 for this runtime; found ^8.0.1",
      path: "apps/mobile/package.json",
    });
  });

  test("keeps caller catalog additions from overriding toolchain pins", async () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        catalog: {
          oxlint: "1.77.0",
          tsrs: "0.17.0",
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual([]);
  });

  test("accepts the API compiler aggregate while rejecting arbitrary wrappers", async () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: { devDependencies: { turbo: "2.10.3" } },
      webPackageJson: { name: "@stll/web" },
    });
    mkdirSync(path.join(rootDir, "apps/api/src"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "apps/api/src/value.ts"),
      "export type Value = string;\n",
    );
    writeFileSync(
      path.join(rootDir, "apps/api/tsconfig.src.json"),
      JSON.stringify({ include: ["src/**/*.ts"] }),
    );
    const filename = path.join(rootDir, "apps/api/package.json");
    const writeManifest = (typecheck: string) =>
      writeFileSync(
        filename,
        JSON.stringify({
          name: "@stll/api",
          scripts: {
            typecheck,
            "typecheck:src":
              "bun check --no-pretty --all --project=tsconfig.src.json",
          },
        }),
      );
    writeManifest("bun ../../packages/scripts/src/api-typecheck.ts");
    expect(
      (await validateWorkspaceRoot(rootDir, LOCAL)).some((issue) =>
        issue.message.startsWith("scripts.typecheck must use"),
      ),
    ).toBe(false);
    writeManifest("bun scripts/unchecked-wrapper.ts");
    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      path: "apps/api/package.json",
      message:
        "scripts.typecheck must use bun check --no-pretty --all --project=<tsconfig>; found bun scripts/unchecked-wrapper.ts",
    });
  });

  test("rejects workspace scripts that shadow Bun's checker", async () => {
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
    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message: "scripts.check shadows Bun's native checker; rename the script",
      path: "apps/web/package.json",
    });
  });

  test("rejects a stale centralized lint configuration", async () => {
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

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message: `devDependencies.@stll/oxlint-config must be ${repositoryPackage.devDependencies["@stll/oxlint-config"]}; found 0.6.0`,
      path: "package.json",
    });
  });

  test("rejects deprecated Oxc and non-Bun typecheck scripts", async () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {
        devDependencies: {
          "oxlint-tsgolint": "0.25.0",
          turbo: "2.10.3",
        },
      },
      webPackageJson: {
        dependencies: {},
        devDependencies: {
          typescript6: "catalog:",
          typescript: "catalog:",
        },
        name: "@stll/web",
        scripts: { typecheck: "tsc --noEmit" },
      },
    });

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toEqual(
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
            "typescript is not a workspace dependency: bun check embeds TypeScript 7 and tsrs serves its compiler API; only apps/landing pins its own TypeScript 6 for Astro's checker",
          path: "apps/web/package.json",
        },
        {
          message:
            "The TypeScript 6 compiler API is compatibility-only and may only be declared by the root",
          path: "apps/web/package.json",
        },
      ]),
    );
  });

  test("rejects the TypeScript 6 compiler API in the ported scripts package", async () => {
    const rootDir = createWorkspaceRoot({
      rootPackageJson: {},
      webPackageJson: {
        dependencies: {},
        name: "@stll/web",
      },
    });
    writeFileSync(
      path.join(rootDir, "packages/scripts/package.json"),
      JSON.stringify({
        dependencies: { typescript6: "catalog:" },
        name: "@stll/scripts",
        scripts: {
          typecheck: "bun check --no-pretty --all --project=tsconfig.json",
        },
      }),
    );

    expect(await validateWorkspaceRoot(rootDir, LOCAL)).toContainEqual({
      message:
        "The TypeScript 6 compiler API is compatibility-only and may only be declared by the root",
      path: "packages/scripts/package.json",
    });
  });

  test("rejects the TypeScript 6 compiler API in apps/api", async () => {
    const apiTypecheck = "bun ../../packages/scripts/src/api-typecheck.ts";
    const declaring = createWorkspaceRoot({
      apiPackageJson: {
        devDependencies: { typescript6: "catalog:" },
        name: "@stll/api",
        scripts: { typecheck: apiTypecheck },
      },
      rootPackageJson: {},
      webPackageJson: { name: "@stll/web" },
    });
    expect(await validateWorkspaceRoot(declaring, LOCAL)).toContainEqual({
      message:
        "The TypeScript 6 compiler API is compatibility-only and may only be declared by the root",
      path: "apps/api/package.json",
    });

    const clean = createWorkspaceRoot({
      apiPackageJson: {
        devDependencies: { tsrs: "catalog:" },
        name: "@stll/api",
        scripts: { typecheck: apiTypecheck },
      },
      rootPackageJson: {},
      webPackageJson: { name: "@stll/web" },
    });
    expect(await validateWorkspaceRoot(clean, LOCAL)).not.toContainEqual(
      expect.objectContaining({ path: "apps/api/package.json" }),
    );
  });
});

type CreateWorkspaceRootOptions = {
  apiPackageJson?: Record<string, unknown>;
  mobilePackageJson?: Record<string, unknown>;
  rootPackageJson: Record<string, unknown>;
  webPackageJson: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const createWorkspaceRoot = ({
  apiPackageJson,
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
      tsrs: repositoryPackage.catalog.tsrs,
      typescript6: "npm:typescript@6.0.3",
    },
    catalogs: { ts6: { typescript: "6.0.3" } },
    devDependencies: {
      "@stll/oxlint-config":
        repositoryPackage.devDependencies["@stll/oxlint-config"],
      typescript6: "catalog:",
      "oxlint-tsgolint": "7.0.2003",
      tsrs: "catalog:",
      ...rootDevDependencies,
    },
  };

  mkdirSync(path.join(rootDir, "apps/web/src"), { recursive: true });
  mkdirSync(path.join(rootDir, "apps/landing"), { recursive: true });
  mkdirSync(path.join(rootDir, "packages/scripts"), { recursive: true });
  mkdirSync(path.join(rootDir, "apps/api"), { recursive: true });
  writeFileSync(
    path.join(rootDir, "apps/api/package.json"),
    JSON.stringify({
      devDependencies: { tsrs: "catalog:" },
      name: "@stll/api",
      scripts: {
        typecheck: "bun check --no-pretty --all --project=tsconfig.json",
      },
    }),
  );
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
      devDependencies: {
        "@astrojs/check": "^0.9.9",
        typescript: "catalog:ts6",
      },
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
      name: "@stll/scripts",
      scripts: {
        typecheck: "bun check --no-pretty --all --project=tsconfig.json",
      },
    }),
  );

  if (apiPackageJson) {
    mkdirSync(path.join(rootDir, "apps/api"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "apps/api/package.json"),
      JSON.stringify(apiPackageJson),
    );
  }

  if (mobilePackageJson) {
    mkdirSync(path.join(rootDir, "apps/mobile"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "apps/mobile/package.json"),
      JSON.stringify(mobilePackageJson),
    );
  }

  return rootDir;
};
