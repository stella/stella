import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import config from "../oxlint.config.ts";
import { readScopes } from "./oxlint-config-scopes.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const RESTRICTED_IMPORT_CODE = "eslint(no-restricted-imports)";
const diagnosticReport = v.object({
  diagnostics: v.array(v.object({ code: v.string() })),
});

// Oxlint scopes overrides by path relative to the config, and the repository
// forbids tests from writing inside the checkout. So the probe lives in a
// temporary tree laid out like the repository, linted with a config made of the
// real `no-restricted-imports` scopes and nothing else.
const restrictedImportScopes = () =>
  readScopes(config)
    .filter(({ rules }) => "no-restricted-imports" in rules)
    .map(({ files, excludeFiles, rules }) => ({
      files,
      excludeFiles,
      rules: { "no-restricted-imports": rules["no-restricted-imports"] },
    }));

const restrictedImportCount = async (
  relativePath: string,
  source: string,
): Promise<number> => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-ui-imports-"));
  try {
    const input = path.join(directory, relativePath);
    await Bun.write(input, source);
    const scopes = restrictedImportScopes();
    await Bun.write(
      path.join(directory, "oxlint.config.ts"),
      `export default ${JSON.stringify({
        categories: { correctness: "off" },
        overrides: scopes,
      })};`,
    );
    const process = Bun.spawn(
      [
        "bun",
        "--bun",
        "oxlint",
        "-c",
        path.join(directory, "oxlint.config.ts"),
        "--format",
        "json",
        input,
      ],
      { cwd: repositoryRoot, stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect([0, 1]).toContain(exitCode);
    expect(stderr).not.toContain("Failed to load");
    return v
      .parse(diagnosticReport, JSON.parse(stdout))
      .diagnostics.filter(({ code }) => code === RESTRICTED_IMPORT_CODE).length;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const HELPER_IMPORT = `import { restoreRealTimers } from "@stll/property-testing/fake-timers";\nexport { restoreRealTimers };\n`;

test("a ui test file may import a workspace test-helper package", async () => {
  expect(
    await restrictedImportCount("packages/ui/src/probe.test.ts", HELPER_IMPORT),
  ).toBe(0);
  expect(
    await restrictedImportCount(
      "packages/ui/src/probe.dom.test.tsx",
      HELPER_IMPORT,
    ),
  ).toBe(0);
});

test("a ui source file may not import a workspace test-helper package", async () => {
  expect(
    await restrictedImportCount("packages/ui/src/probe.ts", HELPER_IMPORT),
  ).toBeGreaterThan(0);
});

test("a ui test file may not import a workspace package that is not a test helper", async () => {
  expect(
    await restrictedImportCount(
      "packages/ui/src/probe.test.ts",
      `import { toMinor } from "@stll/money";\nexport { toMinor };\n`,
    ),
  ).toBeGreaterThan(0);
  expect(
    await restrictedImportCount(
      "packages/ui/src/probe.test.ts",
      `import { Button } from "@stll/ui/button";\nexport { Button };\n`,
    ),
  ).toBeGreaterThan(0);
});
