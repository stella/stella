// The files the SQL performance rule covers. The oxlint override and the
// baseline counter both read these lists, so a file the rule reports is a file
// the baseline counts, and the reverse.

const ROOTS = ["apps/api/src/", "packages/"] as const;
const EXCLUDED_DIRECTORIES = [
  "__tests__",
  "tests",
  "__fixtures__",
  "fixtures",
  "drizzle",
] as const;
const EXCLUDED_PREFIXES = ["apps/api/src/db/schema/"] as const;

export const SQL_PERF_LINT_FILES = ROOTS.map((root) => `${root}**/*.{ts,tsx}`);

export const SQL_PERF_LINT_EXCLUDES = [
  "**/*.{test,spec}.{ts,tsx}",
  ...EXCLUDED_DIRECTORIES.map((directory) => `**/${directory}/**`),
  ...EXCLUDED_PREFIXES.map((prefix) => `${prefix}**`),
];

/** Repo-relative path, forward slashes. */
export const isSqlPerfSource = (file: string): boolean => {
  if (!ROOTS.some((root) => file.startsWith(root))) {
    return false;
  }
  if (!file.endsWith(".ts") && !file.endsWith(".tsx")) {
    return false;
  }
  if (/\.(?:test|spec)\.tsx?$/u.test(file)) {
    return false;
  }
  const directories = new Set(file.split("/").slice(0, -1));
  if (
    EXCLUDED_DIRECTORIES.some((directory) => directories.has(directory))
  ) {
    return false;
  }
  return !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix));
};
