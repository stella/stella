#!/usr/bin/env bun
// The totality guards in apps/api/src/lib/projection-totality.ts (see that
// file) only protect a handler that opts in by importing them. A handler
// that reads schema rows and sends them to a client but never imports the
// guard can drift silently, exactly like `properties/list.ts` once did
// before the guard existed at all. This script makes that opt-in
// mandatory: it finds every handler module shaped like a resource
// projection and fails CI unless it either imports the guard or carries a
// reasoned allowlist entry admitting it is unguarded.
//
// This does not retrofit guards -- it only makes the current gap visible
// and keeps it from growing unnoticed. A module on the allowlist is backlog,
// not an exception to fix later without review.
//
// Usage: bun scripts/check-projection-totality.ts

import { panic } from "better-result";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const API_SOURCE_ROOT = path.join(REPO_ROOT, "apps/api/src");
const HANDLERS_ROOT = path.join(API_SOURCE_ROOT, "handlers");
const MCP_ROOT = path.join(API_SOURCE_ROOT, "mcp");
const ALLOWLIST_PATH = path.join(
  REPO_ROOT,
  "scripts/projection-totality.allowlist.json",
);
const PROJECTION_TOTALITY_IMPORT = "@/api/lib/projection-totality";

type AllowlistEntry = {
  file: string;
  reason: string;
};

type ProjectionModule = {
  relativePath: string;
  guarded: boolean;
};

// A resource-projection module's basename names the read side of a
// resource: a list/detail page, a get, or a response/read-model shaped for
// return to a client. Deliberately loose (a "list-pagination.ts" or
// "list-cursor.ts" helper matches too) -- a false positive only costs an
// allowlist line, while a false negative hides a real gap.
const CLIENT_FACING_FILENAME =
  /(^|[/-])(list|get|read|read-model|response|list-query|detail)(\.|-)/u;

// Any one of these substrings is enough to call a file "reads rows from a
// schema table": a row type derived straight from the table, or a query
// method that returns whole rows. `.select({` only matches an inline
// selection object; a module whose select passes a hoisted selection
// constant is still caught because such modules also declare a
// `$inferSelect` row type for their totality guard.
const READS_SCHEMA_ROWS_MARKERS = [
  "$inferSelect",
  ".findMany(",
  ".findFirst(",
  ".select({",
] as const;

/**
 * True when `relativePath` (posix-separated, relative to the repo root)
 * is a handler module this check should classify at all: application
 * `.ts` source under apps/api/src/handlers, excluding tests, the route
 * table, and schema re-exports.
 */
export const shouldScanHandlerFile = (relativePath: string): boolean => {
  if (!relativePath.endsWith(".ts")) {
    return false;
  }
  // Also excludes *.integration.test.ts, *.property.test.ts, and
  // *.db.test.ts, which share this suffix.
  if (relativePath.endsWith(".test.ts")) {
    return false;
  }
  const basename = path.basename(relativePath);
  if (basename === "routes.ts") {
    return false;
  }
  if (/^schema.*\.ts$/u.test(basename)) {
    return false;
  }
  return true;
};

type ResourceProjectionModuleOptions = {
  relativePath: string;
  content: string;
  /** Some route table or MCP module reaches this module through imports. */
  responseReachable: boolean;
};

/**
 * True when a handler module is shaped like a resource projection: it reads
 * rows from a schema table AND returns them to a client, per the two marker
 * sets above. A `$inferSelect` row type alone counts only in a module a
 * response surface can reach: an internal pipeline module (a worker store,
 * a scheduled job) types its rows the same way but never serializes them.
 */
export const isResourceProjectionModule = ({
  relativePath,
  content,
  responseReachable,
}: ResourceProjectionModuleOptions): boolean => {
  const readsSchemaRows = READS_SCHEMA_ROWS_MARKERS.some((marker) =>
    content.includes(marker),
  );
  if (!readsSchemaRows) {
    return false;
  }
  return (
    CLIENT_FACING_FILENAME.test(relativePath) ||
    (responseReachable && content.includes("$inferSelect"))
  );
};

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/gu;

/** The module specifiers a source file imports, statically or dynamically. */
export const importSpecifiersOf = (content: string): string[] =>
  Array.from(content.matchAll(IMPORT_SPECIFIER), (match) => match[1] ?? "");

const RESOLVABLE_SUFFIXES = [".ts", ".tsx", "/index.ts"] as const;

// Only the API's own modules matter: a package or a builtin cannot lead back
// into a handler.
const resolveApiImport = (
  fromAbsolute: string,
  specifier: string,
): string | null => {
  const apiBase = (): string | null => {
    if (specifier.startsWith("@/api/")) {
      return path.join(API_SOURCE_ROOT, specifier.slice("@/api/".length));
    }
    if (specifier.startsWith(".")) {
      return path.resolve(path.dirname(fromAbsolute), specifier);
    }
    return null;
  };
  const base = apiBase();
  if (base === null) {
    return null;
  }
  if (base.endsWith(".ts") && existsSync(base)) {
    return base;
  }
  const suffix = RESOLVABLE_SUFFIXES.find((candidate) =>
    existsSync(`${base}${candidate}`),
  );
  return suffix === undefined ? null : `${base}${suffix}`;
};

const isResponseRoot = (absolute: string): boolean =>
  !absolute.endsWith(".test.ts") &&
  (path.basename(absolute) === "routes.ts" ||
    absolute.startsWith(`${MCP_ROOT}${path.sep}`));

/**
 * Every API module a route table or MCP module reaches through imports: the
 * modules whose rows can end up in a client response.
 */
export const collectResponseReachable = (
  apiFiles: readonly string[],
): Set<string> => {
  const reached = new Set<string>();
  const pending = apiFiles.filter(isResponseRoot);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (reached.has(next)) {
      continue;
    }
    reached.add(next);
    for (const specifier of importSpecifiersOf(readFileSync(next, "utf-8"))) {
      const resolved = resolveApiImport(next, specifier);
      if (resolved !== null && !reached.has(resolved)) {
        pending.push(resolved);
      }
    }
  }
  return reached;
};

const walk = (directory: string, out: string[]): void => {
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      walk(absolute, out);
    } else if (stats.isFile()) {
      out.push(absolute);
    }
  }
};

const collectApiFiles = (): string[] => {
  const files: string[] = [];
  walk(API_SOURCE_ROOT, files);
  return files.filter((absolute) => absolute.endsWith(".ts"));
};

const collectHandlerFiles = (apiFiles: readonly string[]): string[] =>
  apiFiles.filter(
    (absolute) =>
      absolute.startsWith(`${HANDLERS_ROOT}${path.sep}`) &&
      shouldScanHandlerFile(repoRelativePath(REPO_ROOT, absolute)),
  );

type CollectProjectionModulesOptions = {
  files: readonly string[];
  responseReachable: ReadonlySet<string>;
};

const collectProjectionModules = ({
  files,
  responseReachable,
}: CollectProjectionModulesOptions): ProjectionModule[] => {
  const modules: ProjectionModule[] = [];
  for (const absolute of files) {
    const relativePath = repoRelativePath(REPO_ROOT, absolute)
      .split(path.sep)
      .join("/");
    const content = readFileSync(absolute, "utf-8");
    if (
      !isResourceProjectionModule({
        relativePath,
        content,
        responseReachable: responseReachable.has(absolute),
      })
    ) {
      continue;
    }
    modules.push({
      relativePath,
      guarded: content.includes(PROJECTION_TOTALITY_IMPORT),
    });
  }
  return modules;
};

const isAllowlistEntry = (value: unknown): value is AllowlistEntry =>
  typeof value === "object" &&
  value !== null &&
  "file" in value &&
  "reason" in value &&
  typeof value.file === "string" &&
  typeof value.reason === "string" &&
  // The reason is the only reviewable evidence that an exception is
  // deliberate; an empty one is not an allowlist entry.
  value.reason.trim().length > 0;

const loadAllowlist = (): AllowlistEntry[] => {
  const raw = readFileSync(ALLOWLIST_PATH, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isAllowlistEntry)) {
    return panic(
      `${repoRelativePath(REPO_ROOT, ALLOWLIST_PATH)} must be a JSON array of { file, reason } entries`,
    );
  }
  return parsed;
};

const main = (): void => {
  const apiFiles = collectApiFiles();
  const projectionModules = collectProjectionModules({
    files: collectHandlerFiles(apiFiles),
    responseReachable: collectResponseReachable(apiFiles),
  });

  const projectionModuleByPath = new Map(
    projectionModules.map((module) => [module.relativePath, module]),
  );
  const allowlist = loadAllowlist();
  let failed = false;

  for (const entry of allowlist) {
    const module = projectionModuleByPath.get(entry.file);
    if (!module) {
      failed = true;
      console.error(
        `stale allowlist entry: ${entry.file} no longer exists or no longer classifies as a resource projection module -- remove it from ${repoRelativePath(REPO_ROOT, ALLOWLIST_PATH)}`,
      );
    } else if (module.guarded) {
      failed = true;
      console.error(
        `stale allowlist entry: ${entry.file} now imports ${PROJECTION_TOTALITY_IMPORT} -- remove it from ${repoRelativePath(REPO_ROOT, ALLOWLIST_PATH)}`,
      );
    }
  }

  const allowlistedPaths = new Set(allowlist.map((entry) => entry.file));
  const unguarded = projectionModules.filter((module) => !module.guarded);
  const missingGuardOrAllowlist = unguarded.filter(
    (module) => !allowlistedPaths.has(module.relativePath),
  );

  for (const module of missingGuardOrAllowlist) {
    failed = true;
    console.error(
      `unguarded resource projection: ${module.relativePath} reads schema rows and returns them to a client, but imports no totality guard from ${PROJECTION_TOTALITY_IMPORT} and carries no ${repoRelativePath(REPO_ROOT, ALLOWLIST_PATH)} entry`,
    );
  }

  if (failed) {
    process.exit(1);
  }

  console.log(
    `check-projection-totality: OK, ${projectionModules.length} resource projection modules found ` +
      `(${projectionModules.length - unguarded.length} guarded, ${unguarded.length} allowlisted backlog).`,
  );
};

if (import.meta.main) {
  main();
}
