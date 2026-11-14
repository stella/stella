import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { GENERATORS } from "./generated-files";
import {
  buildRootInputs,
  decide,
  LANDING_PACKAGE,
  type Lockfile,
  parseLockfile,
  type Revision,
  workspaceClosure,
} from "./landing-deploy-scope";

const lockfile = (
  packages: Record<string, readonly unknown[]> = {},
): Lockfile => ({
  workspaces: {
    "": { name: "root", devDependencies: { tooling: "^1.0.0" } },
    "apps/landing": {
      name: "@stll/landing",
      dependencies: { "@stll/ui": "workspace:*", site: "^1.0.0" },
    },
    "apps/web": { name: "@stll/web", dependencies: { app: "^1.0.0" } },
    "packages/ui": { name: "@stll/ui", devDependencies: { styles: "^1.0.0" } },
    "packages/editor-utils": { name: "@stll/editor-utils" },
  },
  packages: {
    "@stll/ui": ["@stll/ui@workspace:packages/ui"],
    "@stll/editor-utils": [
      "@stll/editor-utils@workspace:packages/editor-utils",
    ],
    site: [
      "site@1.0.0",
      "",
      { dependencies: { shared: "^1.0.0", "@stll/editor-utils": "^0.1.0" } },
      "sha512-site",
    ],
    "site/shared": ["shared@2.0.0", "", {}, "sha512-shared-2"],
    shared: ["shared@1.0.0", "", {}, "sha512-shared-1"],
    styles: ["styles@1.0.0", "", {}, "sha512-styles"],
    app: [
      "app@1.0.0",
      "",
      { dependencies: { shared: "^1.0.0" } },
      "sha512-app",
    ],
    tooling: ["tooling@1.0.0", "", {}, "sha512-tooling"],
    ...packages,
  },
  patchedDependencies: {},
  trustedDependencies: [],
});

const revision = (
  lock: Lockfile | undefined,
  overrides: Partial<Revision> = {},
): Revision => ({
  lock,
  packageManager: "bun@1.0.0",
  patchContents: () => "",
  ...overrides,
});

const ROOT_INPUTS = ["docs/changelog/**", "scripts/product-media.ts"];

const decideFor = (
  changedFiles: readonly string[],
  head: Revision = revision(lockfile()),
  base: Revision = revision(lockfile()),
) =>
  decide({
    packageName: LANDING_PACKAGE,
    changedFiles,
    rootInputs: ROOT_INPUTS,
    base,
    head,
  }).affected;

test("the closure follows workspace links, including ones a published package makes", () => {
  const closure = workspaceClosure(lockfile(), LANDING_PACKAGE);
  expect(closure?.workspaceDirectories).toEqual(
    new Set(["apps/landing", "packages/ui", "packages/editor-utils"]),
  );
  // The nested copy wins over the hoisted one below `site`.
  expect(closure?.packageKeys.has("site/shared")).toBe(true);
  expect(closure?.packageKeys.has("shared")).toBe(false);
  expect(closure?.packageKeys.has("app")).toBe(false);
  expect(closure?.packageKeys.has("tooling")).toBe(false);
});

test("files in the landing's workspaces and declared inputs affect it", () => {
  expect(decideFor(["apps/landing/src/pages/index.astro"])).toBe(true);
  expect(decideFor(["packages/ui/src/button.tsx"])).toBe(true);
  expect(decideFor(["packages/editor-utils/src/index.ts"])).toBe(true);
  expect(decideFor(["docs/changelog/v1.0.0.md"])).toBe(true);
  expect(decideFor(["scripts/product-media.ts"])).toBe(true);
  expect(decideFor(["bunfig.toml"])).toBe(true);
});

test("files outside the landing's inputs leave it alone", () => {
  expect(
    decideFor([
      "apps/web/src/main.tsx",
      "apps/landing-extra/file.ts",
      "scripts/product-media.test.ts",
      "docs/plans/next.md",
    ]),
  ).toBe(false);
});

test("a lockfile change counts only when it moves a landing package", () => {
  const unrelated = lockfile({
    app: ["app@1.1.0", "", {}, "sha512-app-1.1"],
    shared: ["shared@1.1.0", "", {}, "sha512-shared-1.1"],
  });
  expect(
    decideFor(["bun.lock", "apps/web/package.json"], revision(unrelated)),
  ).toBe(false);

  const related = lockfile({
    "site/shared": ["shared@2.0.1", "", {}, "sha512-shared-2.0.1"],
  });
  expect(decideFor(["bun.lock"], revision(related))).toBe(true);
});

test("a patch or runtime change counts only for the landing's packages", () => {
  const patched = (target: string): Lockfile => ({
    ...lockfile(),
    patchedDependencies: { [target]: `patches/${target}.patch` },
  });
  const edited = (lock: Lockfile) =>
    revision(lock, { patchContents: () => "edited" });

  expect(
    decideFor(
      ["patches/app@1.0.0.patch"],
      edited(patched("app@1.0.0")),
      revision(patched("app@1.0.0")),
    ),
  ).toBe(false);
  expect(
    decideFor(
      ["patches/site@1.0.0.patch"],
      edited(patched("site@1.0.0")),
      revision(patched("site@1.0.0")),
    ),
  ).toBe(true);
  expect(
    decideFor(
      ["package.json"],
      revision(lockfile(), { packageManager: "bun@1.0.1" }),
    ),
  ).toBe(true);
});

test("the decision follows the named package's own graph", () => {
  const decideForWeb = (changedFiles: readonly string[], head = lockfile()) =>
    decide({
      packageName: "@stll/web",
      changedFiles,
      rootInputs: [],
      base: revision(lockfile()),
      head: revision(head),
    }).affected;
  expect(decideForWeb(["apps/web/src/main.tsx"])).toBe(true);
  expect(decideForWeb(["apps/landing/src/pages/index.astro"])).toBe(false);
  expect(decideForWeb(["packages/ui/src/button.tsx"])).toBe(false);
  expect(
    decideForWeb(
      ["bun.lock"],
      lockfile({ shared: ["shared@1.1.0", "", {}, "sha512-shared-1.1"] }),
    ),
  ).toBe(true);
  expect(
    decide({
      packageName: "@stll/missing",
      changedFiles: ["docs/plans/next.md"],
      rootInputs: [],
      base: revision(lockfile()),
      head: revision(lockfile()),
    }).affected,
  ).toBe(true);
});

test("an unreadable lockfile fails towards a deploy", () => {
  expect(decideFor(["apps/web/src/main.tsx"], revision(undefined))).toBe(true);
});

test("the repository declares the landing build's outside reads", () => {
  const inputs = buildRootInputs(
    Bun.JSONC.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
    ),
    LANDING_PACKAGE,
  );
  expect(inputs).toContain("docs/changelog/**");
  const lock = parseLockfile(
    Bun.JSONC.parse(
      readFileSync(new URL("../bun.lock", import.meta.url), "utf-8"),
    ),
  );
  expect(
    lock && workspaceClosure(lock, LANDING_PACKAGE)?.workspaceDirectories,
  ).toContain("apps/landing");
});

test("CLI runtime generator inputs trigger deployment through the real build declarations", () => {
  const rootInputs = buildRootInputs(
    Bun.JSONC.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
    ),
    LANDING_PACKAGE,
  );
  const runtime = GENERATORS.find(({ id }) => id === "cli-runtime");
  if (runtime === undefined) {
    throw new TypeError("CLI runtime generator is missing");
  }
  const cliInputs = runtime.inputs.filter((input) =>
    input.startsWith("packages/cli/"),
  );
  expect(cliInputs.length).toBeGreaterThan(0);
  const base = revision(lockfile());
  const head = revision(lockfile());
  for (const file of cliInputs) {
    const changedFiles = [file];
    expect(
      decide({
        packageName: LANDING_PACKAGE,
        changedFiles,
        rootInputs: [],
        base,
        head,
      }).affected,
      file,
    ).toBe(false);
    expect(
      decide({
        packageName: LANDING_PACKAGE,
        changedFiles,
        rootInputs,
        base,
        head,
      }).affected,
      file,
    ).toBe(true);
  }
});

test("the command compares two commits and fails towards a deploy", () => {
  const script = path.join(import.meta.dirname, "landing-deploy-scope.ts");
  const repo = mkdtempSync(path.join(tmpdir(), "landing-deploy-scope-"));
  const run = (command: readonly string[]) =>
    Bun.spawnSync([...command], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
  const commit = (file: string, content: string): string => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
    run(["git", "add", "--all"]);
    run(["git", "commit", "--quiet", "--no-verify", "--message", file]);
    return run(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  };
  const scope = (base: string, head: string, packageName = LANDING_PACKAGE) =>
    run([
      "bun",
      script,
      "--package",
      packageName,
      "--base",
      base,
      "--head",
      head,
    ])
      .stdout.toString()
      .trim();

  try {
    run(["git", "init", "--quiet"]);
    writeFileSync(path.join(repo, "bun.lock"), JSON.stringify(lockfile()));
    writeFileSync(
      path.join(repo, "turbo.json"),
      JSON.stringify({
        tasks: {
          "@stll/landing#build": { inputs: ["$TURBO_ROOT$/docs/changelog/**"] },
        },
      }),
    );
    const base = commit("apps/web/src/main.tsx", "1");
    const unrelated = commit("apps/web/src/main.tsx", "2");
    const changelog = commit("docs/changelog/v1.0.0.md", "notes");
    const landing = commit("apps/landing/src/index.astro", "page");

    expect(scope(base, unrelated)).toBe("false");
    expect(scope(base, changelog)).toBe("true");
    expect(scope(changelog, landing)).toBe("true");
    expect(scope("0".repeat(40), landing)).toBe("true");
    expect(scope("f".repeat(40), landing)).toBe("true");
    expect(scope(changelog, landing, "@stll/web")).toBe("false");
    expect(scope(base, unrelated, "@stll/web")).toBe("true");
    const missing = run(["bun", script, "--base", base, "--head", landing]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout.toString()).toBe("");
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});
