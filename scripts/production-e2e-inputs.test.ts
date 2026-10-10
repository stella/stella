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

import { repoRelativePath } from "@stll/portable-path";

import { productionE2eInputs } from "./production-e2e-inputs.mjs";

const productionConfig = path.resolve(
  import.meta.dirname,
  "../apps/web/e2e/playwright.config.ts",
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
      "node",
      "--input-type=module",
      "--eval",
      `import { productionE2eInputs } from ${JSON.stringify(moduleUrl)}; productionE2eInputs(${JSON.stringify(configPath)});`,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(message);
    expect(result.stdout.toString()).toBe("");
  });
}
