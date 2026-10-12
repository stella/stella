#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const ROUTE_SMOKE_SPEC_PATH = "apps/web/e2e/specs/route-smoke.spec.ts";
const ENTRY_POINTS = [
  ROUTE_SMOKE_SPEC_PATH,
  "apps/web/e2e/playwright.config.ts",
  // Playwright loads this by configuration string, rather than an import.
  "apps/web/e2e/global-teardown.ts",
] as const;
// Each extension parses with its own grammar: TSX would reject valid `.ts`
// syntax such as generic arrows (`<T = unknown>(value: T) => value`).
const LOADERS = {
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".jsx": "jsx",
} as const;
type SourceExtension = keyof typeof LOADERS;
const SOURCE_EXTENSIONS = Object.keys(LOADERS);
const isSourceExtension = (extension: string): extension is SourceExtension =>
  Object.hasOwn(LOADERS, extension);
const RUNTIME_FILES = new Set([
  ".github/workflows/ci.yml",
  "scripts/detect-route-smoke-changes.ts",
  "scripts/detect-route-smoke-changes.test.ts",
  "bun.lock",
  "bunfig.toml",
  "package.json",
  ".npmrc",
  "turbo.json",
  "docker-compose.yml",
  "scripts/retry.sh",
  "apps/web/e2e/network-baseline.json",
]);
const RUNTIME_PREFIXES = [
  "apps/api/",
  "packages/",
  "patches/",
  "docker/",
  "apps/web/src/",
  "apps/web/public/",
  "apps/web/scripts/",
  "scripts/network-baseline-",
  // Helpers read these from disk (e.g. the uploaded document), so the import
  // graph cannot see them.
  "apps/web/e2e/fixtures/",
  "apps/web/e2e/network-budgets/",
  ".github/actions/prepare-network-baseline/",
  ".github/actions/setup-e2e-stack/",
  ".github/actions/setup-production-e2e/",
  ".github/actions/setup-playwright/",
  ".github/actions/build-e2e-web/",
];

const normalizePath = (file: string): string =>
  path.posix.normalize(file.replaceAll("\\", "/")).replace(/^\.\//u, "");

const runtimePath = (file: string): boolean =>
  RUNTIME_FILES.has(file) ||
  RUNTIME_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
  // Web build/runtime configuration lives beside src, outside the import graph.
  (file.startsWith("apps/web/") &&
    !file.slice("apps/web/".length).includes("/"));

// Keep every resolution candidate in the closure, even if it is now deleted.
// Reading only existing modules would miss a removed helper still imported by
// the spec, which must run (and fail) on that pull request.
const importCandidates = (importer: string, specifier: string): string[] => {
  if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
    // Workspace dependencies are covered by packages/ and apps/api/ above.
    return [];
  }
  const target = specifier.startsWith(".")
    ? path.posix.join(path.posix.dirname(importer), specifier)
    : `apps/web/src/${specifier.slice(2)}`;
  const normalized = normalizePath(target);
  if (normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    return [];
  }
  const candidates = [normalized];
  if (path.posix.extname(normalized) === "") {
    for (const extension of SOURCE_EXTENSIONS) {
      candidates.push(`${normalized}${extension}`);
      candidates.push(`${normalized}/index${extension}`);
    }
  } else if (/\.[cm]?jsx?$/u.test(normalized)) {
    // TypeScript commonly imports .js while the checked-in source is .ts.
    const stem = normalized.replace(/\.[cm]?jsx?$/u, "");
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`);
  }
  return candidates;
};

export const routeSmokeImportClosure = (
  root = REPO_ROOT,
): ReadonlySet<string> => {
  const visited = new Set<string>();
  const pending: string[] = [...ENTRY_POINTS];
  // Bun is already installed by ci-plan; no repository install is needed to
  // parse imports, re-exports and literal dynamic imports without regex drift.
  const parsers = new Map<SourceExtension, Bun.Transpiler>();
  const parserFor = (extension: SourceExtension): Bun.Transpiler => {
    const existing = parsers.get(extension);
    if (existing !== undefined) {
      return existing;
    }
    const parser = new Bun.Transpiler({ loader: LOADERS[extension] });
    parsers.set(extension, parser);
    return parser;
  };
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const absolute = path.join(root, file);
    const extension = path.posix.extname(file);
    if (
      !existsSync(absolute) ||
      !statSync(absolute).isFile() ||
      !isSourceExtension(extension)
    ) {
      continue;
    }
    for (const imported of parserFor(extension).scanImports(
      readFileSync(absolute, "utf-8"),
    )) {
      pending.push(...importCandidates(file, imported.path));
    }
  }
  return visited;
};

export const routeSmokeAffected = (
  changedFiles: readonly string[],
  root = REPO_ROOT,
): boolean => {
  const files = changedFiles.map(normalizePath);
  if (files.some(runtimePath)) {
    return true;
  }
  const imports = routeSmokeImportClosure(root);
  return files.some((file) => imports.has(file));
};

if (import.meta.main) {
  console.log(routeSmokeAffected(process.argv.slice(2)));
}
