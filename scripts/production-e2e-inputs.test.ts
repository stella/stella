import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";

import { repoRelativePath } from "@stll/portable-path";

import {
  productionE2eChanged,
  productionE2eInputs,
  productionWebPackages,
  productionWebSource,
} from "./production-e2e-inputs.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const productionConfig = path.resolve(
  repositoryRoot,
  "apps/web/e2e/playwright.config.ts",
);
const directory = mkdtempSync(path.join(tmpdir(), "production-e2e-inputs-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("production input scope follows the config's testDir and imported modules", () => {
  const config = readFileSync(productionConfig, "utf-8");
  const testDir = /\btestDir:\s*["']([^"']+)["']/u.exec(config)?.[1];
  expect(testDir).toBeDefined();
  if (testDir === undefined) {
    throw new TypeError("Production config has no testDir");
  }
  const { testDirectory, files } = productionE2eInputs(productionConfig);
  expect(testDirectory).toBe(
    path.resolve(path.dirname(productionConfig), testDir),
  );
  const relativeFiles = [...files].map((file) =>
    repoRelativePath(path.dirname(productionConfig), file),
  );
  expect(relativeFiles).toContain("helpers/test.ts");
  expect(relativeFiles).toContain("execution-profile.ts");
  expect(relativeFiles).toContain("global-teardown.ts");
  expect(relativeFiles).toContain("fixtures/simple.docx");
  expect(relativeFiles).toContain("network-baseline.json");
  expect(relativeFiles).not.toContain("fixtures/generate.ts");
  expect(relativeFiles).not.toContain("playwright.collab.config.ts");
  expect(relativeFiles.some((file) => file.startsWith("collab/"))).toBe(false);
});

test("changed paths resolve from the repository root outside its working directory", () => {
  const originalWorkingDirectory = process.cwd();
  process.chdir(directory);
  try {
    expect(
      productionE2eChanged(["apps/web/e2e/specs/law-cases-ssr.spec.ts"]),
    ).toBe(true);
    expect(productionE2eChanged(["README.md"])).toBe(false);
  } finally {
    process.chdir(originalWorkingDirectory);
  }
});

test("shipped web source changes the production suite; tests, stories and docs do not", () => {
  for (const file of [
    "apps/web/src/components/breadcrumbs/chat-switcher.tsx",
    "apps/web/src/routes/_protected.chat/-components/chat-history-link.tsx",
    "apps/web/src/lib/react-query.ts",
    "apps/web/src/i18n/namespaces/en/core.json",
    "apps/web/src/fonts.css",
  ]) {
    expect(productionWebSource(file), file).toBe(true);
    expect(productionE2eChanged(["README.md", file]), file).toBe(true);
  }
  for (const file of [
    "apps/web/src/components/breadcrumbs/chat-breadcrumb.dom.test.tsx",
    "apps/web/src/lib/react-query.test.ts",
    "apps/web/src/components/button.stories.tsx",
    "apps/web/src/i18n/TERMINOLOGY.md",
    "apps/web/package.json",
    "apps/web/srcs/page.tsx",
    "apps/landing/src/page.tsx",
  ]) {
    expect(productionWebSource(file), file).toBe(false);
    expect(productionE2eChanged([file]), file).toBe(false);
  }
});

test("bundled workspace package source changes the production suite; tooling and dev-only packages do not", () => {
  for (const file of [
    "packages/ui/src/components/view-toolbar.tsx",
    "packages/ui/src/styles/globals.css",
    "packages/locales/src/index.ts",
    // Reached through @stll/api-contract and @stll/chat, not apps/web itself.
    "packages/uuid-codec/src/index.ts",
    "packages/html/src/load.ts",
    // Bundled folders beside src: committed WASM, exported assets and
    // entries, and an exported script.
    "packages/scan-engine/generated/scan_engine_bg.wasm",
    "packages/catalogue/entries/skills/jurisrank/manifest.json",
    "packages/catalogue/scripts/pinned-content-facts.ts",
  ]) {
    expect(productionWebSource(file), file).toBe(true);
    expect(productionE2eChanged(["README.md", file]), file).toBe(true);
  }
  for (const file of [
    "packages/ui/src/components/view-toolbar.test.tsx",
    "packages/ui/src/components/button.stories.tsx",
    "packages/ui/README.md",
    "packages/ui/package.json",
    "packages/ui/vite.config.ts",
    "packages/ui/scripts/generate-icons.ts",
    "packages/html/tests/load.ts",
    "packages/scan-engine/fixtures/blank.pgm",
    // Dev-only workspace packages of apps/web and packages nothing ships.
    "packages/playwright-tools/src/index.ts",
    "packages/ssr-testkit/src/index.ts",
    "packages/property-testing/src/index.ts",
    "packages/cli/src/index.ts",
    "packages/uis/src/index.ts",
  ]) {
    expect(productionWebSource(file), file).toBe(false);
    expect(productionE2eChanged([file]), file).toBe(false);
  }
});

const PackageManifest = v.object({
  name: v.string(),
  dependencies: v.optional(v.record(v.string(), v.string())),
  devDependencies: v.optional(v.record(v.string(), v.string())),
});

test("bundled packages are the web app's transitive runtime workspace dependencies", () => {
  const manifest = (packageDirectory: string) =>
    v.parse(
      PackageManifest,
      JSON.parse(
        readFileSync(
          path.join(repositoryRoot, packageDirectory, "package.json"),
          "utf-8",
        ),
      ),
    );
  const web = manifest("apps/web");
  const shipped = productionWebPackages();
  const names = new Set(shipped.map((entry) => manifest(entry.directory).name));
  // Every direct runtime workspace dependency ships, so a new one needs no
  // list edit.
  for (const [name, specifier] of Object.entries(web.dependencies ?? {})) {
    expect(names.has(name), name).toBe(specifier.startsWith("workspace:"));
  }
  expect(names).toContain("@stll/ui");
  expect(names).toContain("@stll/uuid-codec");
  for (const name of Object.keys(web.devDependencies ?? {})) {
    if (!(name in (web.dependencies ?? {}))) {
      expect(names.has(name), name).toBe(false);
    }
  }
  // Each package's exported entry points count as shipped.
  for (const { directory: packageDirectory, exports } of shipped) {
    expect(exports.length, packageDirectory).toBeGreaterThan(0);
    for (const target of exports) {
      if (/\.(?:mdx?|d\.ts)$/u.test(target)) {
        continue;
      }
      const file = path.posix.join(
        packageDirectory,
        target.replace("*", "entry.ts"),
      );
      expect(productionWebSource(file), file).toBe(true);
    }
  }
});

test("the bundled package graph follows workspace manifests", () => {
  const root = mkdtempSync(path.join(directory, "graph-"));
  const write = (file: string, content: unknown) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), JSON.stringify(content));
  };
  write("package.json", { workspaces: ["apps/*", "packages/*", "tools/kit"] });
  write("apps/web/package.json", {
    name: "web",
    dependencies: { direct: "workspace:^", external: "^1.0.0" },
    devDependencies: { kit: "workspace:*" },
  });
  write("packages/direct/package.json", {
    name: "direct",
    exports: { ".": "./src/index.ts", "./data/*": "./data/*" },
    dependencies: { transitive: "workspace:*" },
    devDependencies: { kit: "workspace:*" },
  });
  write("packages/transitive/package.json", {
    name: "transitive",
    main: "./index.ts",
  });
  write("tools/kit/package.json", { name: "kit" });
  expect(productionWebPackages(root)).toEqual([
    { directory: "packages/direct", exports: ["src/index.ts", "data/*"] },
    { directory: "packages/transitive", exports: ["index.ts"] },
  ]);
  for (const file of [
    "packages/direct/src/index.ts",
    "packages/direct/data/table.json",
    "packages/transitive/index.ts",
    "packages/transitive/lib/helper.ts",
  ]) {
    expect(productionWebSource(file, root), file).toBe(true);
  }
  for (const file of [
    "packages/direct/package.json",
    "packages/direct/tsconfig.json",
    "packages/direct/src/index.test.ts",
    "packages/transitive/tests/helper.ts",
    "tools/kit/src/index.ts",
  ]) {
    expect(productionWebSource(file, root), file).toBe(false);
  }

  const missing = mkdtempSync(path.join(directory, "missing-"));
  mkdirSync(path.join(missing, "apps/web"), { recursive: true });
  writeFileSync(
    path.join(missing, "package.json"),
    JSON.stringify({ workspaces: ["apps/*"] }),
  );
  writeFileSync(
    path.join(missing, "apps/web/package.json"),
    JSON.stringify({ name: "web", dependencies: { gone: "workspace:*" } }),
  );
  expect(() => productionWebPackages(missing)).toThrow(
    "Workspace dependency gone has no workspace package",
  );
});

test("input derivation follows a different testDir, transitive imports and setup assets", () => {
  for (const folder of ["suite", "shared", "assets", "unrelated"]) {
    mkdirSync(path.join(directory, folder));
  }
  const fixtureFiles = {
    "playwright.config.ts":
      'import "./shared/profile"; export default { testDir: "./suite", globalTeardown: "./cleanup.ts" };',
    "suite/new.spec.ts": 'import "../shared/fixture";',
    "shared/profile.ts": 'export const profile = "production";',
    "shared/fixture.ts":
      'import "./cycle"; export const data = "../assets/input.json";',
    "shared/cycle.ts": 'import "./fixture";',
    "cleanup.ts": 'import "./shared/fixture";',
    "assets/input.json": "{}",
    "unrelated/other.spec.ts": "export {};",
    "playwright.other.config.ts": 'export default { testDir: "./unrelated" };',
  };
  for (const [file, content] of Object.entries(fixtureFiles)) {
    writeFileSync(path.join(directory, file), content);
  }
  // Playwright snapshot folders can have source-looking names.
  mkdirSync(path.join(directory, "suite", "snapshot.spec.ts"));
  const { testDirectory, files } = productionE2eInputs(
    path.join(directory, "playwright.config.ts"),
  );
  expect(testDirectory).toBe(path.join(directory, "suite"));
  expect(
    [...files].map((file) => repoRelativePath(directory, file)).toSorted(),
  ).toEqual(
    Object.keys(fixtureFiles)
      .filter(
        (file) =>
          !file.startsWith("unrelated/") &&
          file !== "playwright.other.config.ts",
      )
      .toSorted(),
  );
});

for (const [config, message] of [
  ["export default {};", "must declare a literal testDir"],
  [
    'export default { testDir: "../outside" };',
    "must stay inside its E2E tree",
  ],
  [
    'import "./missing.ts"; export default { testDir: "./suite" };',
    "Unresolved production E2E input",
  ],
] as const) {
  test(`invalid config fails through the dependency-free CLI: ${message}`, () => {
    const fixture = mkdtempSync(path.join(directory, "invalid-"));
    mkdirSync(path.join(fixture, "suite"));
    const configPath = path.join(fixture, "playwright.config.ts");
    writeFileSync(configPath, config);
    const moduleUrl = pathToFileURL(
      path.join(import.meta.dirname, "production-e2e-inputs.mjs"),
    ).href;
    const result = Bun.spawnSync([
      process.execPath,
      "--input-type=module",
      "--eval",
      `import { productionE2eInputs } from ${JSON.stringify(moduleUrl)}; productionE2eInputs(${JSON.stringify(configPath)});`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(message);
    expect(result.stdout.toString()).toBe("");
  });
}
