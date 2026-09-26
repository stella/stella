import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  decide,
  landingBuildRootInputs,
  landingClosure,
  parseLockfile,
  type Lockfile,
  type Revision,
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
) => decide({ changedFiles, rootInputs: ROOT_INPUTS, base, head }).affected;

test("the closure follows workspace links, including ones a published package makes", () => {
  const closure = landingClosure(lockfile());
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

test("an unreadable lockfile fails towards a deploy", () => {
  expect(decideFor(["apps/web/src/main.tsx"], revision(undefined))).toBe(true);
});

test("the repository declares the landing build's outside reads", () => {
  const inputs = landingBuildRootInputs(
    Bun.JSONC.parse(
      readFileSync(new URL("../turbo.json", import.meta.url), "utf-8"),
    ),
  );
  expect(inputs).toContain("docs/changelog/**");
  const lock = parseLockfile(
    Bun.JSONC.parse(
      readFileSync(new URL("../bun.lock", import.meta.url), "utf-8"),
    ),
  );
  expect(lock && landingClosure(lock)?.workspaceDirectories).toContain(
    "apps/landing",
  );
});
