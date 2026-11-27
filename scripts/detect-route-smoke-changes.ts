#!/usr/bin/env bun

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { cachedForRepository } from "./ci-repository-cache";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
export const ROUTE_SMOKE_SPEC_PATH = "apps/web/e2e/specs/route-smoke.spec.ts";
const ENTRY_POINTS = [
  ROUTE_SMOKE_SPEC_PATH,
  // The phone layout walk runs in the route-smoke job too.
  "apps/web/e2e/phone/phone-layout.spec.ts",
  "apps/web/e2e/phone/phone-layout-rules.spec.ts",
  "apps/web/e2e/playwright.phone.config.ts",
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
  "scripts/ci-repository-cache.ts",
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
  // Read from disk by apps/web/e2e/helpers/document.ts (imported by route-smoke).
  "apps/api/src/lib/search/__fixtures__/mixed-3pages.pdf",
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
  // Every spec here runs in the route-smoke job's phone suite, including a
  // new one no entry point imports yet.
  "apps/web/e2e/phone/",
  "apps/web/e2e/network-budgets/",
  ".github/actions/prepare-network-baseline/",
  ".github/actions/setup-e2e-stack/",
  ".github/actions/setup-production-e2e/",
  ".github/actions/setup-playwright/",
  ".github/actions/build-e2e-web/",
];

const normalizePath = (file: string): string =>
  path.posix.normalize(file.replaceAll("\\", "/")).replace(/^\.\//u, "");

const SOURCE_TREE_PREFIXES = [
  "apps/api/",
  "apps/web/src/",
  "packages/",
] as const;
// Unit/DB/property tests, Storybook stories, and test-only directories under
// runtime source trees never ship into the production web or API runtime.
const NON_RUNTIME_SOURCE_FILE =
  /\.(?:test|spec|stories)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|__fixtures__|__mocks__|__snapshots__)\//u;
const NON_RUNTIME_DOC_FILE =
  /(?:^|\/)(?:README|AGENTS|CLAUDE|GEMINI|TERMINOLOGY|CHANGELOG)\.md$|\.research\.md$|(?:^|\/)docs\/.*\.mdx?$/u;
const NON_RUNTIME_API_PREFIXES = [
  "apps/api/src/tests/",
  "apps/api/evals/",
  "apps/api/e2e/",
  "apps/api/typecheck-required/",
] as const;
const isNonRuntimeSourceFile = (file: string): boolean => {
  if (!SOURCE_TREE_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return false;
  }
  if (NON_RUNTIME_SOURCE_FILE.test(file)) {
    return true;
  }
  if (NON_RUNTIME_API_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return true;
  }
  // Only exclude known documentation Markdown files (not bundled runtime
  // prompts/assets such as report prompt templates or template-pack READMEs).
  if (file.startsWith("packages/template-packs/")) {
    return false;
  }
  return NON_RUNTIME_DOC_FILE.test(file);
};

const runtimePath = (file: string): boolean => {
  if (RUNTIME_FILES.has(file)) {
    return true;
  }
  if (isNonRuntimeSourceFile(file)) {
    return false;
  }
  return (
    RUNTIME_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
    // Web build/runtime configuration lives beside src, outside the import graph.
    (file.startsWith("apps/web/") &&
      !file.slice("apps/web/".length).includes("/"))
  );
};

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

export const sourceImportClosure = (
  entryPoints: readonly string[],
  root: string,
): ReadonlySet<string> => {
  const visited = new Set<string>();
  const pending = [...entryPoints];
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
    // scanImports rejects a script's leading shebang line.
    for (const imported of parserFor(extension).scanImports(
      readFileSync(absolute, "utf-8").replace(/^#![^\n]*/u, ""),
    )) {
      pending.push(...importCandidates(file, imported.path));
    }
  }
  return visited;
};

export const routeSmokeImportClosure = (root = REPO_ROOT) =>
  sourceImportClosure(ENTRY_POINTS, root);

const routeSmokeClosures = new Map<string, ReadonlySet<string>>();

export const routeSmokeAffected = (
  changedFiles: readonly string[],
  root = REPO_ROOT,
): boolean => {
  const files = changedFiles.map(normalizePath);
  if (files.some(runtimePath)) {
    return true;
  }
  const imports = cachedForRepository(
    routeSmokeClosures,
    { root, key: root },
    () => routeSmokeImportClosure(root),
  );
  return files.some((file) => imports.has(file));
};

if (import.meta.main) {
  console.log(routeSmokeAffected(process.argv.slice(2)));
}
