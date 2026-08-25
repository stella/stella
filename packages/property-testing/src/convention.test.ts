import { describe, expect, test } from "bun:test";
import path from "node:path";

// Repo root, four levels up from this file (packages/property-testing/src).
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

const TEST_FILE_GLOB = "{apps,packages}/**/*.test.{ts,tsx}";
const PACKAGE_JSON_GLOB = "{apps,packages}/*/package.json";

// The content marker every property runner selects files by: the api runner's
// PROPERTY_TEST_MARKER and each package's `grep -rlF 'fc.assert'` script.
const PROPERTY_MARKER = "fc.assert";
const PROPERTY_SCRIPT = "test:property";

// This guard names the marker in its own source and is not a property test.
const SELF_PATH = "packages/property-testing/src/convention.test.ts";

type PropertyTestFile = { relativePath: string; source: string };

const collectPropertyTestFiles = async (): Promise<PropertyTestFile[]> => {
  const glob = new Bun.Glob(TEST_FILE_GLOB);
  const files: PropertyTestFile[] = [];
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    if (relativePath.includes("node_modules") || relativePath === SELF_PATH) {
      continue;
    }
    const source = await Bun.file(path.resolve(REPO_ROOT, relativePath)).text();
    if (source.includes(PROPERTY_MARKER)) {
      files.push({ relativePath, source });
    }
  }
  return files;
};

/**
 * Guard: every test that uses fast-check's `fc.assert` must route its
 * parameters through `propertyConfig` (from this package). That is what wires a
 * property test into the nightly numRuns scaling + CI verbose replay; a raw
 * `fc.assert` silently opts out of both. The nightly job selects property files
 * by their `fc.assert` content, so a missing `propertyConfig` import means a
 * property test that runs at a fixed budget forever. Catch it at the source.
 */
const collectViolations = async (): Promise<string[]> =>
  (await collectPropertyTestFiles())
    .filter(({ source }) => !source.includes("@stll/property-testing"))
    .map(({ relativePath }) => relativePath);

// Workspace directory ("apps/web", "packages/boe") of a repo-relative path.
const workspaceOf = (relativePath: string): string =>
  relativePath.split("/").slice(0, 2).join("/");

const collectPropertyScriptWorkspaces = async (): Promise<Set<string>> => {
  const glob = new Bun.Glob(PACKAGE_JSON_GLOB);
  const workspaces = new Set<string>();
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    const manifest: { scripts?: Record<string, string> } = await Bun.file(
      path.resolve(REPO_ROOT, relativePath),
    ).json();
    if (manifest.scripts?.[PROPERTY_SCRIPT] !== undefined) {
      workspaces.add(workspaceOf(relativePath));
    }
  }
  return workspaces;
};

const collectPropertyScriptCommands = async (): Promise<
  Map<string, string>
> => {
  const glob = new Bun.Glob(PACKAGE_JSON_GLOB);
  const commands = new Map<string, string>();
  for await (const relativePath of glob.scan({ cwd: REPO_ROOT })) {
    const manifest: { scripts?: Record<string, string> } = await Bun.file(
      path.resolve(REPO_ROOT, relativePath),
    ).json();
    const command = manifest.scripts?.[PROPERTY_SCRIPT];
    if (command !== undefined) {
      commands.set(workspaceOf(relativePath), command);
    }
  }
  return commands;
};

describe("property-test convention", () => {
  test("every fc.assert test imports propertyConfig", async () => {
    expect(await collectViolations()).toEqual([]);
  });

  test("property runners preload the factor-scaled Bun timeout", async () => {
    const commands = await collectPropertyScriptCommands();
    const violations = [...commands].flatMap(([workspace, command]) =>
      /--preload\s+@stll\/property-testing\/preload(?:\s|$)/u.test(command)
        ? []
        : [`${workspace}: test:property does not preload property-testing`],
    );

    expect(violations).toEqual([]);
  });

  /**
   * Guard: the nightly property job runs `turbo run test:property`, so a
   * property test in a workspace without that script never gets the scaled
   * numRuns budget; it runs at its PR budget forever while looking covered.
   * Conversely a workspace with the script but no property file would run
   * its whole suite (`bun test` with an empty selection). Assert the two sets
   * match in both directions.
   */
  test("workspaces with fc.assert tests and test:property scripts coincide", async () => {
    const withPropertyTests = new Set(
      (await collectPropertyTestFiles()).map(({ relativePath }) =>
        workspaceOf(relativePath),
      ),
    );
    const withScript = await collectPropertyScriptWorkspaces();
    expect(withPropertyTests.size).toBeGreaterThan(0);
    expect([...withPropertyTests].sort()).toEqual([...withScript].sort());
  });
});
