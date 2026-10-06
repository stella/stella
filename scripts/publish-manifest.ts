// Transform a package.json from its in-repo "source" shape to the published
// "dist" shape.
//
// The monorepo consumes these packages from source: `exports` point at
// `./src/*.ts`, so every consumer (Bun, tsgo, Vite) resolves source directly
// with no aliases or conditions. The published package must instead expose the
// built artifacts — real `.d.ts` + `.js`, no source — so external consumers do
// not depend on our `.ts` or our bundler resolution.
//
// Shared by scripts/prepare-publish.ts (npm publish) and
// scripts/stage-web-runtime.ts (web runner image staging).

import { panic } from "better-result";

/** A built module: types and implementation, both emitted from one source. */
export type DistModuleEntry = { types: string; import: string };

// An entry is either a built module or a file the build copies verbatim
// (stylesheets: the design-system theme ships as source CSS, since the
// consumer owns the Tailwind build that compiles it). The two are told apart
// the way the exports field itself does it — an object versus a string.
export type DistEntry = DistModuleEntry | string;

export type PublishedManifest = Record<string, unknown> & {
  exports: Record<string, DistEntry>;
  name: string;
  version: string;
};

export const isDistModuleEntry = (entry: DistEntry): entry is DistModuleEntry =>
  typeof entry !== "string";

/** Files in the published tarball an export entry points at. */
export const distEntryFiles = (entry: DistEntry): string[] =>
  isDistModuleEntry(entry) ? [entry.types, entry.import] : [entry];

// A module compiles to `.js` + `.d.ts`; a stylesheet is copied under its own
// name. `.tsx` is a module: a React package's components are its modules.
const MODULE_EXTENSIONS = [".ts", ".tsx"] as const;
const COPIED_EXTENSIONS = [".css"] as const;

const hasExtension = (target: string, extensions: readonly string[]): boolean =>
  extensions.some((extension) => target.endsWith(extension));

const isShippedRootJsonAsset = (
  target: string,
  manifest: Record<string, unknown>,
): boolean =>
  /^\.\/[^/]+\.json$/u.test(target) &&
  Array.isArray(manifest["files"]) &&
  manifest["files"].includes(target.slice(2));

// "./capabilities/*.json": every JSON file directly inside a directory the
// package ships verbatim. Segments may not start with a dot, so the pattern
// can never climb out of the package.
const SHIPPED_ASSET_PATTERN =
  /^\.\/(?<directory>[A-Za-z0-9_-][\w.-]*(?:\/[A-Za-z0-9_-][\w.-]*)*)\/\*\.json$/u;
const BUILT_DIRECTORIES = new Set(["src", "dist"]);

/** The directory a shipped asset pattern lists, or undefined for any other target. */
export const shippedAssetPatternDirectory = (
  target: string,
): string | undefined =>
  SHIPPED_ASSET_PATTERN.exec(target)?.groups?.["directory"];

/**
 * A wildcard export is accepted only in one shape: the subpath maps onto the
 * identical path (so every match keeps its own name), every match is a JSON
 * file directly inside one directory, and the package's `files` allowlist
 * ships that directory as-is. Anything looser names files no check can list.
 */
const isShippedAssetPattern = (
  subpath: string,
  target: string,
  manifest: Record<string, unknown>,
): boolean => {
  const directory = shippedAssetPatternDirectory(target);
  if (directory === undefined || subpath !== target) {
    return false;
  }
  const [root = ""] = directory.split("/");
  return (
    !BUILT_DIRECTORIES.has(root) &&
    Array.isArray(manifest["files"]) &&
    manifest["files"].includes(root)
  );
};

/** Whether a published export entry is a shipped asset pattern. */
export const isShippedAssetPatternEntry = (entry: DistEntry): entry is string =>
  typeof entry === "string" &&
  shippedAssetPatternDirectory(entry) !== undefined;

/**
 * Package-relative files (`capabilities/a.json`) a shipped asset pattern
 * matches, given the names inside its directory. Sorted, so reports and the
 * resolution probe are stable.
 */
export const matchShippedAssetPattern = (
  pattern: string,
  directoryEntries: readonly string[],
): string[] => {
  const directory =
    shippedAssetPatternDirectory(pattern) ??
    panic(`${JSON.stringify(pattern)} is not a shipped asset pattern`);
  return directoryEntries
    .filter((name) => name.endsWith(".json") && !name.includes("/"))
    .toSorted()
    .map((name) => `${directory}/${name}`);
};

/**
 * Refuse a published manifest whose asset patterns match nothing in the built
 * package. `listDirectory` returns the file names in a package-relative
 * directory, or undefined when it does not exist.
 */
export const assertShippedAssetPatternsMatch = (
  manifest: PublishedManifest,
  listDirectory: (directory: string) => readonly string[] | undefined,
): void => {
  for (const [subpath, entry] of Object.entries(manifest.exports)) {
    if (!isShippedAssetPatternEntry(entry)) {
      continue;
    }
    const directory = shippedAssetPatternDirectory(entry) ?? "";
    const entries = listDirectory(directory);
    if (
      entries === undefined ||
      matchShippedAssetPattern(entry, entries).length === 0
    ) {
      panic(
        `${manifest.name}: export "${subpath}" matches no file in ${directory}/ after the build`,
      );
    }
  }
};

// "./src/model/document.ts" -> "./dist/model/document"
const distBase = (srcPath: string): string =>
  srcPath.replace(/^\.\/src\//u, "./dist/").replace(/\.tsx?$/u, "");

// "./src/styles/theme.css" -> "./dist/styles/theme.css"
const distAsset = (srcPath: string): string =>
  srcPath.replace(/^\.\/src\//u, "./dist/");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Validated `exports` map of a source-shaped manifest: subpath -> a single
// source file, an explicitly shipped root JSON asset, or a shipped asset
// pattern (`"./capabilities/*.json": "./capabilities/*.json"`, see
// isShippedAssetPattern). Every other wildcard is rejected: the published map
// has to name what it ships, or the checks below (and the export-resolution
// guard in CI) have nothing to resolve.
export const sourceExportTargets = (
  manifest: unknown,
): Record<string, string> => {
  if (!isRecord(manifest) || typeof manifest["name"] !== "string") {
    panic("package.json must be an object with a name");
  }
  const exportsField = manifest["exports"];
  if (!isRecord(exportsField)) {
    panic(`${manifest["name"]}: exports must be an object`);
  }

  const targets: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(exportsField)) {
    if (
      typeof target !== "string" ||
      !(
        (target.startsWith("./src/") &&
          (hasExtension(target, MODULE_EXTENSIONS) ||
            hasExtension(target, COPIED_EXTENSIONS))) ||
        isShippedRootJsonAsset(target, manifest) ||
        isShippedAssetPattern(subpath, target, manifest)
      )
    ) {
      panic(
        `${manifest["name"]}: expected source export "${subpath}" to be a ./src/*.{ts,tsx,css} string, an explicitly shipped root JSON asset, or a "./<dir>/*.json" pattern mapped onto itself whose <dir> the files allowlist ships, got ${JSON.stringify(target)}`,
      );
    }
    targets[subpath] = target;
  }
  return targets;
};

export const toPublishedManifest = (manifest: unknown): PublishedManifest => {
  const sourceTargets = sourceExportTargets(manifest);
  if (!isRecord(manifest) || typeof manifest["name"] !== "string") {
    panic("package.json must be an object with a name");
  }
  if (typeof manifest["version"] !== "string") {
    panic(`${manifest["name"]}: package.json must have a version`);
  }

  const distExports: Record<string, DistEntry> = {};
  for (const [subpath, target] of Object.entries(sourceTargets)) {
    if (
      isShippedRootJsonAsset(target, manifest) ||
      isShippedAssetPattern(subpath, target, manifest)
    ) {
      distExports[subpath] = target;
      continue;
    }
    if (hasExtension(target, COPIED_EXTENSIONS)) {
      distExports[subpath] = distAsset(target);
      continue;
    }
    const base = distBase(target);
    distExports[subpath] = { types: `${base}.d.ts`, import: `${base}.js` };
  }

  const root =
    distExports["."] ??
    panic(`${manifest["name"]}: exports must include a "." entry`);
  if (!isDistModuleEntry(root)) {
    panic(`${manifest["name"]}: the "." export must be a module, not an asset`);
  }

  // Ship built artifacts and the README; drop `src`. Carry over any non-`src`
  // asset dirs the source `files` allowlist opted in (e.g. TanStack Intent's
  // `skills/`), so published tarballs keep shipping them.
  const carried = Array.isArray(manifest["files"])
    ? manifest["files"].filter(
        (entry: unknown): entry is string =>
          typeof entry === "string" &&
          entry !== "src" &&
          entry !== "dist" &&
          entry !== "README.md",
      )
    : [];

  return {
    ...manifest,
    exports: distExports,
    files: ["dist", "README.md", ...carried],
    main: root.import,
    name: manifest["name"],
    types: root.types,
    version: manifest["version"],
  };
};
