import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { isPathStrictlyInside } from "../packages/portable-path/src/index.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.resolve(
  REPOSITORY_ROOT,
  "apps/web/e2e/playwright.config.ts",
);
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;

// ci-plan imports this before dependency installation, so configuration
// failures throw without importing packages; the CLI entry reports and exits.
/** @type {(message: string) => never} */
const fail = (message) => {
  throw new Error(message);
};

// Read inputs without executing Playwright or installing dependencies: ci-plan
// runs before installation. Runtime source outside E2E stays in full-depth CI.
/** @param {string} configPath Absolute path to the production Playwright config. */
export const productionE2eInputs = (configPath) => {
  const root = path.dirname(configPath);
  const config = readFileSync(configPath, "utf-8");
  const testDir = /\btestDir:\s*["']([^"']+)["']/u.exec(config)?.[1];
  if (testDir === undefined) {
    fail("Production E2E config must declare a literal testDir");
  }
  const testDirectory = path.resolve(root, testDir);
  /** @type {Set<string>} */
  const files = new Set();
  const pending = [configPath];
  const tsconfig = path.join(root, "tsconfig.json");
  if (existsSync(tsconfig)) {
    pending.push(tsconfig);
  }
  if (!isPathStrictlyInside(root, testDirectory)) {
    fail("Production E2E testDir must stay inside its E2E tree");
  }
  for (const file of readdirSync(testDirectory, {
    recursive: true,
    encoding: "utf-8",
  })) {
    if (
      SOURCE_EXTENSION.test(file) &&
      statSync(path.join(testDirectory, file)).isFile()
    ) {
      pending.push(path.join(testDirectory, file));
    }
  }
  for (const file of pending) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    if (!SOURCE_EXTENSION.test(file)) {
      continue;
    }
    const source = readFileSync(file, "utf-8");
    const imports = [
      ...source.matchAll(
        /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s*)["']([^"']+)["']/gu,
      ),
    ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
    // Assets and setup hooks are file references rather than module imports
    // (globalTeardown, DOCX_PATH, the route network baseline).
    const references = [
      ...source.matchAll(/["'](\.{1,2}\/[^"'\n]+)["']/gu),
    ].flatMap((match) => {
      const reference = match[1];
      return reference !== undefined && path.extname(reference) !== ""
        ? [reference]
        : [];
    });
    for (const reference of [...imports, ...references]) {
      if (!reference.startsWith(".")) {
        continue;
      }
      const resolved = path.resolve(path.dirname(file), reference);
      if (!isPathStrictlyInside(root, resolved)) {
        continue;
      }
      const candidates = [
        resolved,
        `${String(resolved)}.ts`,
        `${String(resolved)}.tsx`,
        path.join(resolved, "index.ts"),
      ];
      const input = candidates.find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      );
      if (input === undefined) {
        fail(
          `Unresolved production E2E input: ${String(reference)} in ${file}`,
        );
      }
      pending.push(input);
    }
  }
  return { testDirectory, files };
};

const WEB_PACKAGE_DIRECTORY = "apps/web";
const WEB_SOURCE_ROOT = `${WEB_PACKAGE_DIRECTORY}/src/`;
// Unit tests, stories and docs beside the shipped source stay out of the
// production bundle.
const NOT_SHIPPED = /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.mdx?$/u;
// Fields whose workspace packages the web build bundles; devDependencies
// (test kits, Playwright tools, scripts) never reach it.
const RUNTIME_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
// Package folders that hold build tooling or test inputs rather than shipped
// modules, unless the package exports a path inside them.
const PACKAGE_TOOLING_DIRECTORIES = new Set([
  "__tests__",
  "fixtures",
  "scripts",
  "test",
  "tests",
]);

/**
 * @param {string} root
 * @param {string} directory
 * @returns {Record<string, unknown>}
 */
const readManifest = (root, directory) =>
  JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf-8"));

/** @param {unknown} value @returns {string[]} */
const stringValues = (value) => {
  if (typeof value === "string") {
    return [value];
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
};

/**
 * Workspace package directories by package name, from the root manifest's
 * workspace patterns.
 * @param {string} root
 */
const workspaceDirectories = (root) => {
  const { workspaces } = readManifest(root, ".");
  const patterns = Array.isArray(workspaces)
    ? workspaces
    : stringValues(
        workspaces !== null && typeof workspaces === "object"
          ? /** @type {{ packages?: unknown }} */ (workspaces).packages
          : undefined,
      );
  /** @type {Map<string, string>} */
  const directories = new Map();
  for (const pattern of patterns) {
    if (typeof pattern !== "string") {
      fail("Workspace patterns must be strings");
    }
    const parent = pattern.endsWith("/*") ? pattern.slice(0, -2) : undefined;
    if (/[*?[{!]/u.test(parent ?? pattern)) {
      fail(`Unsupported workspace pattern: ${pattern}`);
    }
    const candidates =
      parent === undefined
        ? [pattern]
        : existsSync(path.join(root, parent))
          ? readdirSync(path.join(root, parent), { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => path.posix.join(parent, entry.name))
          : [];
    for (const directory of candidates) {
      if (!existsSync(path.join(root, directory, "package.json"))) {
        continue;
      }
      const { name } = readManifest(root, directory);
      if (typeof name === "string") {
        directories.set(name, directory);
      }
    }
  }
  return directories;
};

/**
 * @typedef {{ directory: string, exports: string[] }} ShippedPackage
 */

/**
 * Workspace packages the production web build bundles: the web app's runtime
 * workspace dependencies and theirs, transitively.
 * @param {string} root Absolute repository root.
 * @returns {ShippedPackage[]}
 */
export const productionWebPackages = (root = REPOSITORY_ROOT) => {
  const directories = workspaceDirectories(root);
  /** @type {Map<string, ShippedPackage>} */
  const packages = new Map();
  /** @param {Record<string, unknown>} manifest */
  const runtimeWorkspaceDependencies = (manifest) =>
    RUNTIME_DEPENDENCY_FIELDS.flatMap((field) => {
      const dependencies = manifest[field];
      return dependencies !== null && typeof dependencies === "object"
        ? Object.entries(dependencies).flatMap(([name, specifier]) =>
            typeof specifier === "string" && specifier.startsWith("workspace:")
              ? [name]
              : [],
          )
        : [];
    });
  const pending = runtimeWorkspaceDependencies(
    readManifest(root, WEB_PACKAGE_DIRECTORY),
  );
  for (const name of pending) {
    if (packages.has(name)) {
      continue;
    }
    const directory = directories.get(name);
    if (directory === undefined) {
      fail(`Workspace dependency ${name} has no workspace package`);
    }
    const manifest = readManifest(root, directory);
    packages.set(name, {
      directory,
      exports: stringValues([
        manifest["exports"],
        manifest["main"],
        manifest["module"],
      ])
        .filter((target) => target.startsWith("./"))
        .map((target) => path.posix.normalize(target)),
    });
    pending.push(...runtimeWorkspaceDependencies(manifest));
  }
  return [...packages.values()]
    .filter(({ directory }) => directory !== WEB_PACKAGE_DIRECTORY)
    .toSorted((left, right) => left.directory.localeCompare(right.directory));
};

/** @type {Map<string, ShippedPackage[]>} */
const shippedPackagesByRoot = new Map();

/**
 * @param {string} relative Path inside the package.
 * @param {ShippedPackage} shipped
 */
const shippedPackageFile = (relative, { exports }) => {
  const exported = exports.some((target) => {
    const wildcard = target.indexOf("*");
    return wildcard === -1
      ? relative === target
      : relative.startsWith(target.slice(0, wildcard));
  });
  const [folder, ...rest] = relative.split("/");
  // Files at the package root are manifests and tool configuration.
  return (
    exported ||
    (rest.length > 0 &&
      folder !== undefined &&
      !PACKAGE_TOOLING_DIRECTORIES.has(folder))
  );
};

/**
 * Whether a repository-relative path is source the production web build
 * ships: web source, or a module of a workspace package the web app depends
 * on at runtime. The specs drive the built app, so they import none of it: a
 * component change reaches no spec's import graph and needs the whole
 * production suite.
 * @param {string} file Path relative to the repository root.
 * @param {string} root Absolute repository root.
 */
export const productionWebSource = (file, root = REPOSITORY_ROOT) => {
  const normalized = path.posix.normalize(file.replaceAll("\\", "/"));
  if (NOT_SHIPPED.test(normalized)) {
    return false;
  }
  if (normalized.startsWith(WEB_SOURCE_ROOT)) {
    return true;
  }
  let shipped = shippedPackagesByRoot.get(root);
  if (shipped === undefined) {
    shipped = productionWebPackages(root);
    shippedPackagesByRoot.set(root, shipped);
  }
  return shipped.some(
    (entry) =>
      normalized.startsWith(`${entry.directory}/`) &&
      shippedPackageFile(normalized.slice(entry.directory.length + 1), entry),
  );
};

/** @param {readonly string[]} changedFiles Paths relative to the repository root. */
export const productionE2eChanged = (changedFiles) => {
  if (changedFiles.some((file) => productionWebSource(file))) {
    return true;
  }
  const root = path.dirname(CONFIG_PATH);
  const absoluteFiles = changedFiles.map((file) =>
    path.resolve(REPOSITORY_ROOT, file),
  );
  if (!absoluteFiles.some((file) => isPathStrictlyInside(root, file))) {
    return false;
  }
  const { testDirectory, files } = productionE2eInputs(CONFIG_PATH);
  return absoluteFiles.some(
    (file) => isPathStrictlyInside(testDirectory, file) || files.has(file),
  );
};

if (
  process.argv[1] !== undefined &&
  import.meta.filename === path.resolve(process.argv[1])
) {
  try {
    console.log(productionE2eChanged(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
