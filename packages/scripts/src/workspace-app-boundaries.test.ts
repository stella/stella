import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectAppBoundaryEdges,
  validateWorkspaceAppBoundaries,
} from "./workspace-app-boundaries";
import type { GitRunner } from "./workspace-app-boundaries";

// Every call pins its environment, so the result does not depend on whether
// the test itself runs in CI or a pull request.
const LOCAL = { env: {} };
const PULL_REQUEST = {
  env: { CI: "true", GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "main" },
};
const LEDGER_PATH = "scripts/app-boundary-exceptions.json";

let tempRoots: string[] = [];

setDefaultTimeout(30_000);

afterEach(() => {
  for (const tempRoot of tempRoots) {
    rmSync(tempRoot, { force: true, recursive: true });
  }
  tempRoots = [];
});

describe("workspace app boundaries", () => {
  test("detects app dependencies, source imports, path aliases, and includes", async () => {
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
        "const lazyTemplate = import(`@stll/api/lazy-template`);",
        "const requiredTemplate = require(`@stll/api/required-template`);",
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
      '---\nimport type { API } from "@stll/api/types";\n---\n<script type="application/json" set:html={JSON.stringify({})} /><script type="application/ld+json">{"@context": "https://schema.org"}</script><script type="module">import type { ScriptAPI } from "@stll/api/script-types";</script>',
    );

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual(
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
            "source import @stll/api/script-types targets apps/api; import shared code from packages/*",
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
        {
          message:
            "source import @stll/api/lazy-template targets apps/api; import shared code from packages/*",
          path: "apps/web/src/contracts.ts",
        },
        {
          message:
            "source import @stll/api/required-template targets apps/api; import shared code from packages/*",
          path: "apps/web/src/contracts.ts",
        },
      ]),
    );

    expect(
      (await collectAppBoundaryEdges(rootDir)).some(
        ({ specifier }) => specifier === "@stll/api/ignored",
      ),
    ).toBe(false);
  });

  test("reads an Astro script's exact type attribute to decide whether it is code", async () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "apps/landing", { name: "@stll/landing" });
    writeFileSync(
      path.join(rootDir, "apps/landing/src/scripts.astro"),
      [
        "---",
        'const marker = "<script type=\\"application/json\\">";',
        "---",
        '<script data-type="application/json" type="module">import type { A } from "@stll/api/data-type-first";</script>',
        '<script type=module>import type { B } from "@stll/api/unquoted";</script>',
        "<script type='module'>import type { C } from \"@stll/api/single-quoted\";</script>",
        '<script type="text/javascript">import type { D } from "@stll/api/double-quoted";</script>',
        '<script>import type { E } from "@stll/api/untyped";</script>',
        '<script data-note=\'type="application/json"\'>import type { F } from "@stll/api/type-in-value";</script>',
        '<script is:inline define:vars={{ ready: 1 > 0, label: "}" }} type="module">import type { G } from "@stll/api/expression-value";</script>',
        '<SCRIPT TYPE="Module">import type { H } from "@stll/api/upper-case";</SCRIPT>',
        '<script data-type="module" type="application/ld+json">{"@context": "https://schema.org"}</script>',
        '<script type="application/json" data-note="type=module">{"data": true}</script>',
        '<script type=importmap>{"imports": {}}</script>',
        '<script type="application/json" set:html={JSON.stringify({ a: 1 })} />',
      ].join("\n"),
    );

    const specifiers = (await collectAppBoundaryEdges(rootDir))
      .filter(({ source }) => source === "apps/landing/src/scripts.astro")
      .map(({ specifier }) => specifier)
      .toSorted();
    expect(specifiers).toEqual([
      "@stll/api/data-type-first",
      "@stll/api/double-quoted",
      "@stll/api/expression-value",
      "@stll/api/single-quoted",
      "@stll/api/type-in-value",
      "@stll/api/unquoted",
      "@stll/api/untyped",
      "@stll/api/upper-case",
    ]);
  });

  test("resolves inherited TypeScript paths and includes", async () => {
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

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual(
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

  test("fails closed on invalid TypeScript configuration", async () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/web", { name: "@stll/web" });
    writeFileSync(
      path.join(rootDir, "apps/web/tsconfig.json"),
      JSON.stringify({ extends: "./missing.json" }),
    );

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([
      {
        message: expect.stringContaining("invalid TypeScript configuration"),
        path: "apps/web/tsconfig.json",
      },
    ]);
  });

  test("ignores not-yet-generated API typecheck configs but no other missing extends", async () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writeFileSync(
      path.join(rootDir, "apps/api/tsconfig.json"),
      JSON.stringify({ compilerOptions: { types: [] }, include: [] }),
    );
    writeFileSync(
      path.join(rootDir, "apps/api/tsconfig.src.json"),
      JSON.stringify({
        extends: [
          "./tsconfig.json",
          "./.cache/typecheck-declarations/src.json",
        ],
      }),
    );

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([]);

    writeFileSync(
      path.join(rootDir, "apps/api/tsconfig.tests.json"),
      JSON.stringify({
        extends: [
          "./tsconfig.json",
          "./.cache/typecheck-declarations/other.json",
        ],
      }),
    );

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([
      {
        message: expect.stringContaining("invalid TypeScript configuration"),
        path: "apps/api/tsconfig.tests.json",
      },
    ]);
  });

  test("uses Git's tracked, untracked, and ignored file set", async () => {
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

    const edges = await collectAppBoundaryEdges(rootDir);
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

  test("requires the exception ledger to equal the observed debt", async () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "packages/shared", { name: "@stll/shared" });
    const sourcePath = path.join(rootDir, "packages/shared/src/index.ts");
    writeFileSync(sourcePath, 'export type { API } from "@stll/api/types";\n');
    const observed = await collectAppBoundaryEdges(rootDir);
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      `${JSON.stringify(observed, null, 2)}\n`,
    );
    initializeGitRoot(rootDir);

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([]);

    writeFileSync(sourcePath, "export {};\n");
    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([
      {
        message:
          "stale app-boundary exception; remove it now that the dependency no longer exists",
        path: "scripts/app-boundary-exceptions.json:packages/shared/src/index.ts -> @stll/api/types",
      },
    ]);
  });

  test("forbids adding an observed edge to the committed exception ledger", async () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "packages/shared", { name: "@stll/shared" });
    writeFileSync(
      path.join(rootDir, "packages/shared/src/existing.ts"),
      'export type { API } from "@stll/api/existing";\n',
    );
    const baseline = await collectAppBoundaryEdges(rootDir);
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      `${JSON.stringify(baseline, null, 2)}\n`,
    );
    initializeGitRoot(rootDir);

    writeFileSync(
      path.join(rootDir, "packages/shared/src/new-debt.ts"),
      'export type { API } from "@stll/api/new-debt";\n',
    );
    const grownLedger = await collectAppBoundaryEdges(rootDir);
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      `${JSON.stringify(grownLedger, null, 2)}\n`,
    );

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([
      {
        message:
          "new app-boundary exceptions are forbidden; the ledger may only shrink",
        path: "scripts/app-boundary-exceptions.json:packages/shared/src/new-debt.ts -> @stll/api/new-debt",
      },
    ]);
  });

  test("fails closed when Git cannot read the repository", async () => {
    const rootDir = createRoot();
    writeFileSync(path.join(rootDir, LEDGER_PATH), "[]\n");
    initializeGitRoot(rootDir);
    writeFileSync(path.join(rootDir, ".git/config"), "[core\n");

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([
      {
        message: "app-boundary ledger baseline could not be read from Git",
        path: LEDGER_PATH,
      },
    ]);
  });

  test("skips the baseline comparison outside a Git repository locally", async () => {
    const rootDir = createRoot();
    writeFileSync(path.join(rootDir, LEDGER_PATH), "[]\n");

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([]);
  });

  test("requires a Git checkout in CI", async () => {
    const rootDir = createRoot();
    writeFileSync(path.join(rootDir, LEDGER_PATH), "[]\n");

    expect(
      await validateWorkspaceAppBoundaries(rootDir, { env: { CI: "true" } }),
    ).toEqual([
      {
        message: "app-boundary ledger baseline requires a Git checkout in CI",
        path: LEDGER_PATH,
      },
    ]);
  });

  test("skips the baseline comparison without a Git binary locally, and requires one in CI", async () => {
    const rootDir = createRoot();
    writeFileSync(path.join(rootDir, LEDGER_PATH), "[]\n");
    const missingBinary: GitRunner = () => ({ kind: "missing-binary" });

    expect(
      await validateWorkspaceAppBoundaries(rootDir, {
        ...LOCAL,
        git: missingBinary,
      }),
    ).toEqual([]);
    expect(
      await validateWorkspaceAppBoundaries(rootDir, {
        ...PULL_REQUEST,
        git: missingBinary,
      }),
    ).toEqual([
      {
        message: "app-boundary ledger baseline requires a Git checkout in CI",
        path: LEDGER_PATH,
      },
    ]);
  });

  test("fails closed when the base tree cannot be read", async () => {
    const rootDir = createRoot();
    writeFileSync(path.join(rootDir, LEDGER_PATH), "[]\n");
    initializeGitRoot(rootDir);
    const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: rootDir,
      encoding: "utf-8",
    }).trim();
    unlinkSync(
      path.join(rootDir, ".git/objects", tree.slice(0, 2), tree.slice(2)),
    );

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([
      {
        message: "base app-boundary ledger could not be read",
        path: LEDGER_PATH,
      },
    ]);
  });

  test("compares against no baseline when the base has no ledger yet", async () => {
    const rootDir = createRoot();
    writeFileSync(path.join(rootDir, "scripts/.keep"), "");
    initializeGitRoot(rootDir);
    writeFileSync(path.join(rootDir, LEDGER_PATH), "[]\n");

    expect(await validateWorkspaceAppBoundaries(rootDir, PULL_REQUEST)).toEqual(
      [],
    );
  });

  test("fails closed in a pull request whose base branch cannot be resolved", async () => {
    const rootDir = createRoot();
    writeFileSync(path.join(rootDir, LEDGER_PATH), "[]\n");
    initializeGitRoot(rootDir, "feature");

    expect(await validateWorkspaceAppBoundaries(rootDir, PULL_REQUEST)).toEqual(
      [
        {
          message: "app-boundary ledger baseline branch is unavailable",
          path: LEDGER_PATH,
        },
      ],
    );
  });

  test("fails closed when the exception ledger is malformed", async () => {
    const rootDir = createRoot();
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      "not json\n",
    );

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([
      {
        message: "app-boundary ledger must contain valid JSON",
        path: "scripts/app-boundary-exceptions.json",
      },
    ]);
  });

  test("rejects duplicate and inexact exception entries", async () => {
    const rootDir = createRoot();
    writePackage(rootDir, "apps/api", { name: "@stll/api" });
    writePackage(rootDir, "packages/shared", { name: "@stll/shared" });
    writeFileSync(
      path.join(rootDir, "packages/shared/src/index.ts"),
      'export type { API } from "@stll/api/types";\n',
    );
    const [observed] = await collectAppBoundaryEdges(rootDir);
    if (observed === undefined) {
      throw new Error("expected one app-boundary edge");
    }
    writeFileSync(
      path.join(rootDir, "scripts/app-boundary-exceptions.json"),
      JSON.stringify([observed, observed, { ...observed, reason: "extra" }]),
    );

    expect(await validateWorkspaceAppBoundaries(rootDir, LOCAL)).toEqual([
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

const initializeGitRoot = (rootDir: string, branch = "main") => {
  execFileSync("git", ["init", "--quiet", `--initial-branch=${branch}`], {
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
