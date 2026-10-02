import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const CONFIG_PATH = path.resolve(
  import.meta.dirname,
  "../apps/web/e2e/playwright.config.ts",
);
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;

// ci-plan runs with Node before dependency installation; report configuration
// failures through the CLI's stderr/exit contract without importing packages.
/** @type {(message: string) => never} */
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
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
  if (!testDirectory.startsWith(`${String(root)}${String(path.sep)}`)) {
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
      if (!resolved.startsWith(`${String(root)}${String(path.sep)}`)) {
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

if (
  process.argv[1] !== undefined &&
  import.meta.filename === path.resolve(process.argv[1])
) {
  const changedFiles = process.argv.slice(2);
  const root = path.dirname(CONFIG_PATH);
  const absoluteFiles = changedFiles.map((file) => path.resolve(file));
  if (
    !absoluteFiles.some((file) =>
      file.startsWith(`${String(root)}${String(path.sep)}`),
    )
  ) {
    console.log(false);
  } else {
    const { testDirectory, files } = productionE2eInputs(CONFIG_PATH);
    console.log(
      absoluteFiles.some(
        (file) =>
          file.startsWith(`${String(testDirectory)}${String(path.sep)}`) ||
          files.has(file),
      ),
    );
  }
}
