// Resolves oxlint.config.ts scopes against the repository file list the way
// oxlint does: overrides apply in order, and for a given file the last scope
// that mentions a rule supplies that rule's whole configuration. Shared by the
// config guards so they agree on glob semantics (Bun.Glob matches the literal
// bracket filenames the same way oxlint does: `[.]` is a class, `\[` a bracket).

import { panic } from "better-result";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export const LINTED_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/u;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

/** `["error", …options]` → the options; anything else → no options. */
export const ruleOptions = (value: unknown): unknown[] =>
  Array.isArray(value) ? value.slice(1) : [];

export const ruleIsOff = (value: unknown) => {
  const severity = Array.isArray(value) ? value[0] : value;
  return severity === "off" || severity === 0;
};

export type ScopeConfig = {
  scope: string;
  files: string[];
  excludeFiles: string[];
  plugins: string[];
  rules: Record<string, unknown>;
  /** The config object the scope was read from. */
  source: unknown;
};

export const BASE_SCOPE = "<base>";

/** The base rules as one `**` scope, then every override in order. */
export const readScopes = (root: unknown): ScopeConfig[] => {
  if (!isRecord(root)) {
    return [];
  }
  const scopes: ScopeConfig[] = [];
  const baseRules = root["rules"];
  if (isRecord(baseRules)) {
    scopes.push({
      scope: BASE_SCOPE,
      files: ["**"],
      excludeFiles: [],
      plugins: stringArray(root["plugins"]),
      rules: baseRules,
      source: root,
    });
  }
  const overrides = Array.isArray(root["overrides"]) ? root["overrides"] : [];
  for (const override of overrides) {
    if (!isRecord(override)) {
      continue;
    }
    const files = stringArray(override["files"]);
    if (files.length === 0) {
      continue;
    }
    scopes.push({
      scope: files.join(", "),
      files,
      excludeFiles: stringArray(override["excludeFiles"]),
      plugins: stringArray(override["plugins"]),
      rules: isRecord(override["rules"]) ? override["rules"] : {},
      source: override,
    });
  }
  return scopes;
};

const globCache = new Map<string, Bun.Glob>();
export const matches = (pattern: string, file: string) => {
  const cached = globCache.get(pattern) ?? new Bun.Glob(pattern);
  globCache.set(pattern, cached);
  return cached.match(file);
};

export const scopeMatches = (scope: ScopeConfig, file: string) =>
  scope.files.some((pattern) => matches(pattern, file)) &&
  !scope.excludeFiles.some((pattern) => matches(pattern, file));

export const trackedRepoFiles = (): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repoRoot });
  if (!result.success) {
    return panic("git ls-files failed; cannot resolve the override scopes");
  }
  const files = new TextDecoder()
    .decode(result.stdout)
    .split("\0")
    .filter((file) => file.length > 0);
  if (files.length === 0) {
    return panic("git ls-files returned no files");
  }
  return files;
};

export const lintedRepoFiles = () =>
  trackedRepoFiles().filter((file) => LINTED_FILE_PATTERN.test(file));

const GLOB_META = /[*?[{\\]/u;

/**
 * Matches globs against a fixed file list. A glob only ever matches files
 * that start with its literal prefix, so each lookup scans that sorted range
 * instead of the whole repository.
 */
export const createFileIndex = (files: readonly string[]) => {
  const sorted = [...files].toSorted();
  const lowerBound = (prefix: string) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((sorted[middle] ?? "") < prefix) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
  const cache = new Map<string, string[]>();
  const filesMatching = (pattern: string): string[] => {
    const cached = cache.get(pattern);
    if (cached !== undefined) {
      return cached;
    }
    const meta = pattern.search(GLOB_META);
    const prefix = meta === -1 ? pattern : pattern.slice(0, meta);
    const found: string[] = [];
    for (let index = lowerBound(prefix); index < sorted.length; index += 1) {
      const file = sorted[index] ?? "";
      if (!file.startsWith(prefix)) {
        break;
      }
      if (meta === -1 ? file === pattern : matches(pattern, file)) {
        found.push(file);
      }
    }
    cache.set(pattern, found);
    return found;
  };
  const scopeFiles = (scope: {
    files: readonly string[];
    excludeFiles: readonly string[];
  }): Set<string> => {
    const reached = new Set(scope.files.flatMap(filesMatching));
    for (const file of scope.excludeFiles.flatMap(filesMatching)) {
      reached.delete(file);
    }
    return reached;
  };
  return { files: sorted, filesMatching, scopeFiles };
};
