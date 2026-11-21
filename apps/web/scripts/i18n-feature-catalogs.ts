/**
 * Runs the app catalog's i18n checks over every feature catalog.
 *
 * A feature catalog is `<feature>/i18n/langs/<locale>.json` anywhere under
 * `src/` other than the app's own `src/i18n/langs`. Each is checked exactly
 * as the app catalog is, by the same tools pointed at its directory: the
 * source lock and baseline beside it (`<feature>/i18n/`), keys no source
 * under the feature names, and the translation lint.
 *
 * Usage: bun scripts/i18n-feature-catalogs.ts [check | sync | accept <root> <key>...]
 */

import { panic } from "better-result";
import path from "node:path";

const WEB_ROOT = path.resolve(import.meta.dir, "..");
const APP_CATALOG = "src/i18n/langs";
const CHECK = path.resolve(
  WEB_ROOT,
  "../../packages/scripts/src/i18n-check.ts",
);
const LINT = path.resolve(WEB_ROOT, "../../packages/scripts/src/i18n-lint.ts");

/** Every feature catalog's langs directory, relative to `webRoot`, sorted. */
export const featureCatalogRoots = (webRoot: string = WEB_ROOT): string[] =>
  [...new Bun.Glob("src/**/i18n/langs/en.json").scanSync({ cwd: webRoot })]
    .map((file) => path.dirname(file))
    // Fixtures stand in for catalogs in tests; they are not shipped strings.
    .filter((root) => root !== APP_CATALOG && !root.includes("/__fixtures__/"))
    .toSorted();

/** The feature a catalog belongs to: the directory holding its `i18n/`. */
export const featureDirectoryOf = (root: string): string =>
  path.dirname(path.dirname(root));

const run = (command: readonly string[]): boolean => {
  const result = Bun.spawnSync([...command], {
    cwd: WEB_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  return result.exitCode === 0;
};

const checkRoot = (root: string): boolean =>
  run(["bun", CHECK, root, `--unused-in=${featureDirectoryOf(root)}`]) &&
  run(["bun", LINT, root, "--glossary=src/i18n/glossary.json"]);

const main = (args: readonly string[]): boolean => {
  const [mode = "check", ...rest] = args;
  const roots = featureCatalogRoots();
  switch (mode) {
    case "check":
      return roots.map(checkRoot).every(Boolean);
    case "sync":
      return roots
        .map((root) => run(["bun", CHECK, root, "--sync"]))
        .every(Boolean);
    case "accept": {
      const [root, ...keys] = rest;
      if (root === undefined || !roots.includes(root) || keys.length === 0) {
        return panic(
          `Usage: accept <root> <key>...; roots: ${roots.join(", ") || "none"}`,
        );
      }
      return run(["bun", CHECK, root, "--accept", ...keys]);
    }
    default:
      return panic(`Unknown mode "${mode}": use check, sync or accept`);
  }
};

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)) ? 0 : 1);
}
