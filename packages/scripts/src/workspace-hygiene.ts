#!/usr/bin/env bun
import { Result } from "better-result";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import {
  missingPreparedApiTypecheckConfigs,
  validateApiTypecheckProjects,
} from "./api-typecheck-projects";
import { validateWorkspaceAppBoundaries } from "./workspace-app-boundaries";
import type { AppBoundaryOptions } from "./workspace-app-boundaries";

export const WORKSPACE_PARENT_DIRS = ["apps", "packages"] as const;
// Computed filesystem reads retain these repository Markdown inputs.
export const CI_MARKDOWN_READER_INPUTS = [
  "apps/**/*.md",
  "packages/**/*.md",
  "scripts/**/*.md",
  "docs/**/*.md",
];
export const CI_MARKDOWN_READER_COMMAND =
  "bun packages/scripts/src/workspace-hygiene.ts";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
const DENIED_NPM_DEPENDENCIES = new Set([
  "fuse.js",
  "flexsearch",
  "minisearch",
  "lunr",
  "fast-levenshtein",
  "fastest-levenshtein",
  "leven",
  "js-levenshtein",
  "string-similarity",
  "ahocorasick",
  "natural",
  "match-sorter",
  "cmdk",
  "fuzzysort",
  "@leeoniya/ufuzzy",
  "fuzzball",
  "rapidfuzz",
  "fuzzywuzzy",
]);
const DENIED_TEST_RUNNER_DEPENDENCIES = new Set([
  "jest",
  "vitest",
  "mocha",
  "@types/jest",
  "@types/vitest",
  "@types/mocha",
]);
// Packages the API replaced with its own small fetch clients. Each entry names
// the replacement, so the failure says where the behaviour lives now.
const POSTHOG_CLIENT = "apps/api/src/lib/analytics/posthog-client.ts";
const OTLP_LOG_EXPORTER = "apps/api/src/lib/observability/otlp-log-exporter.ts";
const REPLACED_NPM_DEPENDENCIES: ReadonlyMap<string, string> = new Map([
  ["posthog-node", `replaced by the fetch client in ${POSTHOG_CLIENT}`],
  ["@opentelemetry/api", `replaced by the log types in ${OTLP_LOG_EXPORTER}`],
  ["@opentelemetry/api-logs", `replaced by ${OTLP_LOG_EXPORTER}`],
  [
    "@opentelemetry/exporter-logs-otlp-http",
    `replaced by the fetch client in ${OTLP_LOG_EXPORTER}`,
  ],
  ["@opentelemetry/resources", `replaced by ${OTLP_LOG_EXPORTER}`],
  ["@opentelemetry/sdk-logs", `replaced by ${OTLP_LOG_EXPORTER}`],
]);
const DENIED_CARGO_DEPENDENCIES = new Set([
  "strsim",
  "levenshtein",
  "edit-distance",
  "fuzzy-matcher",
  "triple_accel",
  "rapidfuzz",
]);
const CARGO_DEPENDENCY_FIELDS = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
] as const;
// The docs MCP is installed independently outside the apps/packages workspaces.
const STANDALONE_NPM_PACKAGE_JSON_PATHS = [".claude/mcp/package.json"] as const;
const SKIPPED_SCAN_DIRS = new Set([
  ".cache",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);
const CSS_IMPORT_PATTERN =
  /@import\s+(?:url\(\s*)?["'](?<specifier>[^"']+)["']/gu;
const CSS_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//gu;
const TURBO_INSTALL_PATTERN = /\bbun\s+install\s+-g\s+turbo@\d+\.\d+\.\d+\b/gu;
// Bun 1.4 reads `bun --cwd <dir> run <script>` as a bare `bun run`: it prints
// usage and exits 0 without running the script. `bun run --cwd <dir>` and
// `bun --cwd=<dir> run` both run it.
const BUN_SPACED_CWD_RUN_PATTERN = /\bbun\s+--cwd\s+\S+\s+run\b/gu;
const TURBO_VERSION_PATTERN = /^(?<version>\d+\.\d+\.\d+)$/u;
const BABEL_CORE_DEPENDENCY = "@babel/core";
const BUN_TYPES_DEPENDENCY = "bun-types";
const BABEL_MAJOR_PATTERN = /^[~^]?(?<major>\d+)\./u;
const EXACT_PACKAGE_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const BABEL_TOOLCHAINS = [
  { expectedMajor: 7, packagePath: "apps/mobile/package.json" },
] as const;
// `bun check` embeds the TypeScript 7 checker, so no workspace installs a
// `typescript` package for it. Tools that need the TypeScript 7 compiler API
// use `tsrs`; tools not yet ported import TypeScript 6 through the
// `typescript6` alias, and Astro's checker, which supports only TypeScript 5
// and 6, gets its own pinned copy.
const TYPESCRIPT_TOOLCHAIN = {
  oxlint: "1.87.0",
  oxlintConfig: "1.7.0",
  tsgolint: "7.0.2003",
  tsrs: "0.18.0-ts7.1.0-dev.20260929",
  typescript6Api: "npm:typescript@6.0.3",
  typescript6Astro: "6.0.3",
} as const;
// Workspaces whose own scripts import the TypeScript 6 compiler API; each
// declares it so a filtered install links it.
const TYPESCRIPT6_API_PACKAGE_PATHS: ReadonlySet<string> = new Set([
  "apps/api/package.json",
]);
const TYPESCRIPT6_COMPATIBILITY = {
  astro: {
    dependency: "typescript",
    packagePath: "apps/landing/package.json",
    script:
      "bun --cwd=../../packages/cli run codegen:runtime && bun --bun astro check",
    specifier: "catalog:ts6",
  },
  astroCheck: {
    dependency: "@astrojs/check",
    packagePath: "apps/landing/package.json",
    specifier: "^0.9.9",
  },
  compilerApi: {
    dependency: "typescript6",
    packagePath: "apps/api/package.json",
    specifier: "catalog:",
  },
} as const;

export type WorkspaceParentDir = (typeof WORKSPACE_PARENT_DIRS)[number];

export type WorkspaceIssue = {
  message: string;
  path: string;
};

type WorkspacePackageReadResult =
  | {
      dependencyNames: Set<string>;
      name: string | undefined;
      parseFailed: false;
    }
  | {
      dependencyNames: Set<string>;
      name: undefined;
      parseFailed: true;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readWorkspacePackage = (
  packageJsonPath: string,
): WorkspacePackageReadResult => {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return {
      dependencyNames: new Set(),
      name: undefined,
      parseFailed: true,
    };
  }

  if (!isRecord(packageJson)) {
    return {
      dependencyNames: new Set(),
      name: undefined,
      parseFailed: false,
    };
  }

  const maybeName = packageJson["name"];
  return {
    dependencyNames: readDependencyNames(packageJson),
    name: typeof maybeName === "string" ? maybeName : undefined,
    parseFailed: false,
  };
};

const readDependencyNames = (packageJson: Record<string, unknown>) => {
  const dependencyNames = new Set<string>();

  for (const field of DEPENDENCY_FIELDS) {
    const maybeDependencies = packageJson[field];
    if (!isRecord(maybeDependencies)) {
      continue;
    }

    for (const dependencyName of Object.keys(maybeDependencies)) {
      dependencyNames.add(dependencyName);
    }
  }

  return dependencyNames;
};

const validateDeniedNpmDependencies = (
  packageJsonPath: string,
  packageJson: Record<string, unknown> | null,
): WorkspaceIssue[] => {
  const issues: WorkspaceIssue[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson?.[field];
    if (!isRecord(dependencies)) {
      continue;
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      const npmAlias =
        typeof specifier === "string"
          ? /^npm:(?<name>@[^/]+\/[^@]+|[^@/]+)(?:@|$)/u.exec(specifier)
              ?.groups?.["name"]
          : undefined;
      const actualName = npmAlias ?? name;
      if (DENIED_TEST_RUNNER_DEPENDENCIES.has(actualName)) {
        issues.push({
          message: `${actualName} is blocked; tests run on bun test`,
          path: packageJsonPath,
        });
        continue;
      }
      const replacement = REPLACED_NPM_DEPENDENCIES.get(actualName);
      if (replacement !== undefined) {
        issues.push({
          message: `${actualName} is blocked; ${replacement}`,
          path: packageJsonPath,
        });
        continue;
      }
      const deniedName = DENIED_NPM_DEPENDENCIES.has(actualName)
        ? actualName
        : undefined;
      if (deniedName === undefined) {
        continue;
      }
      issues.push({
        message: `${deniedName} is blocked; use @stll/text-search for search functionality`,
        path: packageJsonPath,
      });
    }
  }
  return issues;
};

const cargoDependencyEntries = (
  manifest: Record<string, unknown>,
): readonly (readonly [string, unknown])[] => {
  const tables = [
    manifest,
    isRecord(manifest["workspace"]) ? manifest["workspace"] : {},
    ...(isRecord(manifest["target"])
      ? Object.values(manifest["target"]).filter(isRecord)
      : []),
  ];
  return tables.flatMap((table) =>
    CARGO_DEPENDENCY_FIELDS.flatMap((field) => {
      const dependencies = table[field];
      return isRecord(dependencies) ? Object.entries(dependencies) : [];
    }),
  );
};

const validateDeniedCargoDependencies = (rootDir: string): WorkspaceIssue[] =>
  findFiles(
    rootDir,
    (filePath) => path.basename(filePath) === "Cargo.toml",
  ).flatMap((manifestPath) => {
    const parsed = Result.try((): unknown =>
      Bun.TOML.parse(readFileSync(manifestPath, "utf-8")),
    );
    if (Result.isError(parsed)) {
      return [
        {
          message: "Cargo.toml must contain valid TOML for dependency policy",
          path: repoRelativePath(rootDir, manifestPath),
        },
      ];
    }
    const manifest = parsed.value;
    if (!isRecord(manifest)) {
      return [];
    }
    return cargoDependencyEntries(manifest).flatMap(([name, specifier]) => {
      const packageName = isRecord(specifier)
        ? specifier["package"]
        : undefined;
      const actualName = typeof packageName === "string" ? packageName : name;
      if (!DENIED_CARGO_DEPENDENCIES.has(actualName)) {
        return [];
      }
      return [
        {
          message: `${actualName} is blocked; use @stll/text-search for search functionality`,
          path: repoRelativePath(rootDir, manifestPath),
        },
      ];
    });
  });

const readDependencySpecifier = (
  packageJsonPath: string,
  dependencyName: string,
): string | null => {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return null;
  }

  if (!isRecord(packageJson)) {
    return null;
  }

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (!isRecord(dependencies)) {
      continue;
    }

    const specifier = dependencies[dependencyName];
    if (typeof specifier === "string") {
      return specifier;
    }
  }

  return null;
};

const readPackageJson = (
  packageJsonPath: string,
): Record<string, unknown> | null => {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return null;
  }

  return isRecord(packageJson) ? packageJson : null;
};

const readStringProperty = (
  record: Record<string, unknown> | null,
  field: string,
  property: string,
): string | null => {
  const values = record?.[field];
  if (!isRecord(values)) {
    return null;
  }

  const value = values[property];
  return typeof value === "string" ? value : null;
};

const resolveCatalogVersion = (
  rootPackage: Record<string, unknown> | null,
  dependencyName: string,
  specifier: string,
): string | null => {
  if (specifier === "catalog:") {
    return readStringProperty(rootPackage, "catalog", dependencyName);
  }
  const catalogName = specifier.startsWith("catalog:")
    ? specifier.slice("catalog:".length)
    : "";
  if (catalogName.length === 0) {
    return null;
  }
  const catalogs = rootPackage?.["catalogs"];
  if (!isRecord(catalogs)) {
    return null;
  }
  const catalog = catalogs[catalogName];
  return isRecord(catalog) && typeof catalog[dependencyName] === "string"
    ? catalog[dependencyName]
    : null;
};

const findResolvedPackageJson = (
  rootDir: string,
  workspacePath: string,
  dependencyName: string,
): string | null => {
  let cursor = workspacePath;
  while (cursor.startsWith(rootDir)) {
    const candidate = path.join(
      cursor,
      "node_modules",
      ...dependencyName.split("/"),
      "package.json",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
    if (cursor === rootDir) {
      return null;
    }
    cursor = path.dirname(cursor);
  }
  return null;
};

/**
 * Bun's hoisted linker can leave an older workspace-local package behind
 * after the root catalog moves forward. Runtime resolution prefers that
 * nested copy, so the manifest and lockfile can look correct while Vite
 * bundles old code. Check the same nearest-node_modules path the workspace
 * will resolve and reject exact catalog pins that disagree.
 */
const validateInstalledCatalogVersions = (
  rootDir: string,
  workspacePath: string,
  relativePackagePath: string,
  packageJson: Record<string, unknown> | null,
): WorkspaceIssue[] => {
  const rootPackage = readPackageJson(path.resolve(rootDir, "package.json"));
  const issues: WorkspaceIssue[] = [];

  for (const field of DEPENDENCY_FIELDS) {
    if (field === "peerDependencies") {
      continue;
    }
    const dependencies = packageJson?.[field];
    if (!isRecord(dependencies)) {
      continue;
    }
    for (const [dependencyName, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== "string" || !specifier.startsWith("catalog:")) {
        continue;
      }
      const expectedVersion = resolveCatalogVersion(
        rootPackage,
        dependencyName,
        specifier,
      );
      if (
        expectedVersion === null ||
        !EXACT_PACKAGE_VERSION_PATTERN.test(expectedVersion)
      ) {
        continue;
      }
      const resolvedPackageJsonPath = findResolvedPackageJson(
        rootDir,
        workspacePath,
        dependencyName,
      );
      if (resolvedPackageJsonPath === null) {
        continue;
      }
      const installedVersion = readPackageJson(resolvedPackageJsonPath)?.[
        "version"
      ];
      if (installedVersion === expectedVersion) {
        continue;
      }
      issues.push({
        message: `${dependencyName} resolves to ${typeof installedVersion === "string" ? installedVersion : "an invalid package"}, but ${specifier} requires ${expectedVersion}; remove the stale nested install and reinstall`,
        path: relativePackagePath,
      });
    }
  }

  return issues;
};

const validateTypeScriptToolchain = (rootDir: string): WorkspaceIssue[] => {
  const issues: WorkspaceIssue[] = [];
  const rootPackagePath = path.resolve(rootDir, "package.json");
  const rootPackage = readPackageJson(rootPackagePath);
  const expectedRootValues = [
    {
      dependency: "@stll/oxlint-config",
      field: "devDependencies",
      specifier: TYPESCRIPT_TOOLCHAIN.oxlintConfig,
    },
    {
      dependency: "typescript6",
      field: "devDependencies",
      specifier: "catalog:",
    },
    {
      dependency: "oxlint-tsgolint",
      field: "devDependencies",
      specifier: TYPESCRIPT_TOOLCHAIN.tsgolint,
    },
    {
      dependency: "tsrs",
      field: "devDependencies",
      specifier: "catalog:",
    },
    {
      dependency: "oxlint",
      field: "catalog",
      specifier: TYPESCRIPT_TOOLCHAIN.oxlint,
    },
    {
      dependency: "tsrs",
      field: "catalog",
      specifier: TYPESCRIPT_TOOLCHAIN.tsrs,
    },
    {
      dependency: "typescript6",
      field: "catalog",
      specifier: TYPESCRIPT_TOOLCHAIN.typescript6Api,
    },
  ] as const;

  for (const { dependency, field, specifier } of expectedRootValues) {
    const actual = readStringProperty(rootPackage, field, dependency);
    if (actual === specifier) {
      continue;
    }

    issues.push({
      message: `${field}.${dependency} must be ${specifier}; found ${actual ?? "missing"}`,
      path: "package.json",
    });
  }

  const catalogs = rootPackage?.["catalogs"];
  const astroTypeScript = readStringProperty(
    isRecord(catalogs) ? catalogs : null,
    "ts6",
    "typescript",
  );
  if (astroTypeScript !== TYPESCRIPT_TOOLCHAIN.typescript6Astro) {
    issues.push({
      message: `catalogs.ts6.typescript must be ${TYPESCRIPT_TOOLCHAIN.typescript6Astro}; found ${astroTypeScript ?? "missing"}`,
      path: "package.json",
    });
  }

  for (const exception of Object.values(TYPESCRIPT6_COMPATIBILITY)) {
    const packageJsonPath = path.resolve(rootDir, exception.packagePath);
    const actual = readDependencySpecifier(
      packageJsonPath,
      exception.dependency,
    );
    if (actual !== exception.specifier) {
      issues.push({
        message: `${exception.dependency} is a pinned TypeScript 6 compatibility exception and must be ${exception.specifier}; found ${actual ?? "missing"}`,
        path: exception.packagePath,
      });
    }
  }

  const landingPackage = readPackageJson(
    path.resolve(rootDir, TYPESCRIPT6_COMPATIBILITY.astro.packagePath),
  );
  const landingTypecheck = readStringProperty(
    landingPackage,
    "scripts",
    "typecheck",
  );
  if (landingTypecheck !== TYPESCRIPT6_COMPATIBILITY.astro.script) {
    issues.push({
      message: `scripts.typecheck must remain the isolated Astro TypeScript 6 check ${TYPESCRIPT6_COMPATIBILITY.astro.script}; found ${landingTypecheck ?? "missing"}`,
      path: TYPESCRIPT6_COMPATIBILITY.astro.packagePath,
    });
  }

  for (const parentDir of WORKSPACE_PARENT_DIRS) {
    const parentPath = path.resolve(rootDir, parentDir);
    if (!existsSync(parentPath)) {
      continue;
    }

    for (const entry of readdirSync(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }

      const relativePackagePath = `${parentDir}/${entry.name}/package.json`;
      const packageJsonPath = path.resolve(rootDir, relativePackagePath);
      if (!existsSync(packageJsonPath)) {
        continue;
      }

      const packageJson = readPackageJson(packageJsonPath);
      const typecheck = readStringProperty(packageJson, "scripts", "typecheck");
      if (
        typecheck !== null &&
        relativePackagePath !== TYPESCRIPT6_COMPATIBILITY.astro.packagePath &&
        !(
          relativePackagePath === "apps/api/package.json" &&
          typecheck === "bun ../../packages/scripts/src/api-typecheck.ts"
        ) &&
        !typecheck
          .split("&&")
          .some((command) =>
            command.trim().startsWith("bun check --no-pretty --all --project="),
          )
      ) {
        issues.push({
          message: `scripts.typecheck must use bun check --no-pretty --all --project=<tsconfig>; found ${typecheck}`,
          path: relativePackagePath,
        });
      }

      if (
        typecheck !== null &&
        readStringProperty(packageJson, "scripts", "check") !== null
      ) {
        issues.push({
          message:
            "scripts.check shadows Bun's native checker; rename the script",
          path: relativePackagePath,
        });
      }

      if (
        readDependencySpecifier(packageJsonPath, "typescript") !== null &&
        relativePackagePath !== TYPESCRIPT6_COMPATIBILITY.astro.packagePath
      ) {
        issues.push({
          message:
            "typescript is not a workspace dependency: bun check embeds TypeScript 7 and tsrs serves its compiler API; only apps/landing pins its own TypeScript 6 for Astro's checker",
          path: relativePackagePath,
        });
      }

      if (
        readDependencySpecifier(packageJsonPath, "typescript6") !== null &&
        !TYPESCRIPT6_API_PACKAGE_PATHS.has(relativePackagePath)
      ) {
        issues.push({
          message:
            "The TypeScript 6 compiler API is compatibility-only and may only be declared by apps/api (and the root)",
          path: relativePackagePath,
        });
      }
    }
  }

  return issues;
};

const validateBabelToolchains = (rootDir: string): WorkspaceIssue[] => {
  const mobilePackagePath = path.resolve(
    rootDir,
    BABEL_TOOLCHAINS[0].packagePath,
  );
  if (!existsSync(mobilePackagePath)) {
    return [];
  }

  const issues: WorkspaceIssue[] = [];
  for (const { expectedMajor, packagePath } of BABEL_TOOLCHAINS) {
    const packageJsonPath = path.resolve(rootDir, packagePath);
    const specifier = existsSync(packageJsonPath)
      ? readDependencySpecifier(packageJsonPath, BABEL_CORE_DEPENDENCY)
      : null;
    const declaredMajor = specifier
      ? Number(BABEL_MAJOR_PATTERN.exec(specifier)?.groups?.["major"])
      : Number.NaN;

    if (declaredMajor === expectedMajor) {
      continue;
    }

    issues.push({
      message: `${BABEL_CORE_DEPENDENCY} must declare major ${expectedMajor} for this runtime; found ${specifier ?? "no direct dependency"}`,
      path: packagePath,
    });
  }

  return issues;
};

const readRootTurboVersion = (rootDir: string): string | null => {
  const packageJsonPath = path.resolve(rootDir, "package.json");
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return null;
  }

  if (!isRecord(packageJson) || !isRecord(packageJson["devDependencies"])) {
    return null;
  }

  const turboSpecifier = packageJson["devDependencies"]["turbo"];
  if (typeof turboSpecifier !== "string") {
    return null;
  }

  return (
    TURBO_VERSION_PATTERN.exec(turboSpecifier)?.groups?.["version"] ?? null
  );
};

export const expectedWorkspaceName = (directoryName: string) =>
  `@stll/${directoryName}`;

const toPackageSpecifier = (specifier: string): string | null => {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(specifier)
  ) {
    return null;
  }

  const segments = specifier.split("/");
  const firstSegment = segments.at(0);
  if (!firstSegment) {
    return null;
  }

  if (!firstSegment.startsWith("@")) {
    return firstSegment;
  }

  const secondSegment = segments.at(1);
  if (!secondSegment) {
    return null;
  }

  return `${firstSegment}/${secondSegment}`;
};

const findCssFiles = (directoryPath: string): string[] => {
  const cssFiles: string[] = [];

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_SCAN_DIRS.has(entry.name)) {
        continue;
      }

      cssFiles.push(...findCssFiles(path.join(directoryPath, entry.name)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".css")) {
      cssFiles.push(path.join(directoryPath, entry.name));
    }
  }

  return cssFiles;
};

const lineNumberForIndex = (content: string, index: number) =>
  content.slice(0, index).split("\n").length;

const stripCssComments = (content: string) =>
  content.replaceAll(CSS_COMMENT_PATTERN, (comment) =>
    comment.replaceAll(/[^\r\n]/gu, " "),
  );

const validateCssImportOwnership = (
  workspacePath: string,
  relativeWorkspacePath: string,
  dependencyNames: ReadonlySet<string>,
): WorkspaceIssue[] => {
  const issues: WorkspaceIssue[] = [];

  for (const cssFilePath of findCssFiles(workspacePath)) {
    const content = stripCssComments(readFileSync(cssFilePath, "utf-8"));

    for (const match of content.matchAll(CSS_IMPORT_PATTERN)) {
      const specifier = match.groups?.["specifier"];
      if (!specifier) {
        continue;
      }

      const packageSpecifier = toPackageSpecifier(specifier);
      if (!packageSpecifier || dependencyNames.has(packageSpecifier)) {
        continue;
      }

      issues.push({
        message: `CSS import ${specifier} resolves to package ${packageSpecifier}, but ${packageSpecifier} is not declared in this workspace package.json`,
        path: `${relativeWorkspacePath}/${cssFilePath.slice(workspacePath.length + 1)}:${lineNumberForIndex(content, match.index)}`,
      });
    }
  }

  return issues;
};

const findFiles = (
  directoryPath: string,
  shouldInclude: (filePath: string) => boolean,
): string[] => {
  if (!existsSync(directoryPath)) {
    return [];
  }

  const files: string[] = [];

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIPPED_SCAN_DIRS.has(entry.name)) {
        continue;
      }

      files.push(
        ...findFiles(path.join(directoryPath, entry.name), shouldInclude),
      );
      continue;
    }

    const filePath = path.join(directoryPath, entry.name);
    if (entry.isFile() && shouldInclude(filePath)) {
      files.push(filePath);
    }
  }

  return files;
};

const validateBunTypeOwnership = (
  workspacePath: string,
  relativeWorkspacePath: string,
  dependencyNames: ReadonlySet<string>,
): WorkspaceIssue[] => {
  if (dependencyNames.has(BUN_TYPES_DEPENDENCY)) {
    return [];
  }

  return findFiles(
    workspacePath,
    (filePath) =>
      path.basename(filePath).startsWith("tsconfig") &&
      filePath.endsWith(".json"),
  )
    .filter((filePath) =>
      readFileSync(filePath, "utf-8").includes(`"${BUN_TYPES_DEPENDENCY}"`),
    )
    .map((filePath) => ({
      message: `${BUN_TYPES_DEPENDENCY} is named by this TypeScript project but is not declared in the workspace package.json`,
      path: `${relativeWorkspacePath}/${repoRelativePath(workspacePath, filePath)}`,
    }));
};

const findTurboInstallPinFiles = (rootDir: string) => [
  ...findFiles(path.resolve(rootDir, "apps"), (filePath) =>
    filePath.endsWith("Dockerfile"),
  ),
  ...findFiles(
    path.resolve(rootDir, ".github", "workflows"),
    (filePath) => filePath.endsWith(".yml") || filePath.endsWith(".yaml"),
  ),
];

const validateTurboInstallPins = (rootDir: string): WorkspaceIssue[] => {
  if (readRootTurboVersion(rootDir) === null) {
    return [
      {
        message:
          "root package.json must define devDependencies.turbo as an exact semver version",
        path: "package.json",
      },
    ];
  }

  const issues: WorkspaceIssue[] = [];

  for (const filePath of findTurboInstallPinFiles(rootDir)) {
    const content = readFileSync(filePath, "utf-8");
    for (const match of content.matchAll(TURBO_INSTALL_PATTERN)) {
      // The pattern ends at the version, and `turbo@` is its only `@`.
      const installVersion = match[0].slice(match[0].lastIndexOf("@") + 1);
      issues.push({
        message: `turbo install version must derive from root package.json; found mirrored pin ${installVersion}`,
        path: `${repoRelativePath(rootDir, filePath)}:${lineNumberForIndex(content, match.index)}`,
      });
    }
  }

  return issues;
};

const isBunCommandFile = (filePath: string) => {
  const name = path.basename(filePath);
  return (
    name === "package.json" ||
    name === "Dockerfile" ||
    [".md", ".sh", ".yml", ".yaml"].includes(path.extname(name))
  );
};

const findBunCommandFiles = (rootDir: string) => [
  path.resolve(rootDir, "package.json"),
  ...[
    "apps",
    "packages",
    "scripts",
    "docs",
    path.join(".github", "workflows"),
  ].flatMap((directory) =>
    findFiles(path.resolve(rootDir, directory), isBunCommandFile),
  ),
];

const validateBunCwdRunForm = (rootDir: string): WorkspaceIssue[] =>
  findBunCommandFiles(rootDir)
    .filter((filePath) => existsSync(filePath))
    .flatMap((filePath) => {
      const content = readFileSync(filePath, "utf-8");
      return [...content.matchAll(BUN_SPACED_CWD_RUN_PATTERN)].map((match) => ({
        message:
          "`bun --cwd <dir> run <script>` exits 0 without running the script; use `bun run --cwd <dir> <script>`",
        path: `${repoRelativePath(rootDir, filePath)}:${lineNumberForIndex(content, match.index)}`,
      }));
    });

export const validateWorkspaceRoot = async (
  rootDir: string,
  appBoundaryOptions: AppBoundaryOptions = {},
  {
    requirePreparedApiTypecheck = false,
  }: {
    requirePreparedApiTypecheck?: boolean;
  } = {},
): Promise<WorkspaceIssue[]> => {
  const issues: WorkspaceIssue[] = [
    ...(await validateApiTypecheckProjects(rootDir, {
      requirePrepared: requirePreparedApiTypecheck,
    })),
    ...(await validateWorkspaceAppBoundaries(rootDir, appBoundaryOptions)),
    ...validateTurboInstallPins(rootDir),
    ...validateBunCwdRunForm(rootDir),
    ...validateBabelToolchains(rootDir),
    ...validateTypeScriptToolchain(rootDir),
    ...validateDeniedNpmDependencies(
      "package.json",
      readPackageJson(path.resolve(rootDir, "package.json")),
    ),
    ...STANDALONE_NPM_PACKAGE_JSON_PATHS.flatMap((relativePath) =>
      validateDeniedNpmDependencies(
        relativePath,
        readPackageJson(path.resolve(rootDir, relativePath)),
      ),
    ),
    ...validateDeniedCargoDependencies(rootDir),
  ];

  for (const parentDir of WORKSPACE_PARENT_DIRS) {
    const parentPath = path.resolve(rootDir, parentDir);
    const entries = readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .toSorted((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relativePath = `${parentDir}/${entry.name}`;
      const packageJsonPath = path.resolve(
        parentPath,
        entry.name,
        "package.json",
      );

      if (!existsSync(packageJsonPath)) {
        issues.push({
          message: `direct child of ${parentDir}/ must be a workspace package with package.json`,
          path: relativePath,
        });
        continue;
      }

      const {
        dependencyNames,
        name: workspaceName,
        parseFailed,
      } = readWorkspacePackage(packageJsonPath);
      const expectedName = expectedWorkspaceName(entry.name);

      if (parseFailed) {
        issues.push({
          message: "workspace package.json must contain valid JSON",
          path: relativePath,
        });
        continue;
      }

      if (typeof workspaceName !== "string" || workspaceName.length === 0) {
        issues.push({
          message: "workspace package must define a non-empty name",
          path: relativePath,
        });
        continue;
      }

      if (workspaceName !== expectedName) {
        issues.push({
          message: `workspace package name must be ${expectedName}; found ${workspaceName}`,
          path: relativePath,
        });
      }

      issues.push(
        ...validateDeniedNpmDependencies(
          `${relativePath}/package.json`,
          readPackageJson(packageJsonPath),
        ),
        ...validateBunTypeOwnership(
          path.resolve(parentPath, entry.name),
          relativePath,
          dependencyNames,
        ),
        ...validateCssImportOwnership(
          path.resolve(parentPath, entry.name),
          relativePath,
          dependencyNames,
        ),
        ...validateInstalledCatalogVersions(
          rootDir,
          path.resolve(parentPath, entry.name),
          `${relativePath}/package.json`,
          readPackageJson(packageJsonPath),
        ),
      );
    }
  }

  return issues;
};

if (import.meta.main) {
  // CI runs this as a verification step (STELLA_VERIFY=check) after it has
  // generated the API typecheck configs; the install-time postinstall has not.
  const requirePreparedApiTypecheck = process.env["STELLA_VERIFY"] === "check";
  const unprepared = missingPreparedApiTypecheckConfigs(process.cwd());
  if (unprepared.length > 0 && !requirePreparedApiTypecheck) {
    console.log(
      `Skipping API typecheck ownership: prepared configs are not generated yet (${unprepared.join(", ")}).`,
    );
  }
  const issues = await validateWorkspaceRoot(
    process.cwd(),
    {},
    {
      requirePreparedApiTypecheck,
    },
  );

  if (issues.length === 0) {
    console.log("Workspace layout OK.");
    process.exit(0);
  }

  console.error("Workspace hygiene check failed:");
  for (const issue of issues) {
    console.error(`- ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}
