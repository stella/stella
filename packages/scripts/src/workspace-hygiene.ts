#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const WORKSPACE_PARENT_DIRS = ["apps", "packages"] as const;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
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
const TURBO_INSTALL_PATTERN =
  /\bbun\s+install\s+-g\s+turbo@(?<version>\d+\.\d+\.\d+)\b/gu;
const TURBO_VERSION_PATTERN = /^\^?(?<version>\d+\.\d+\.\d+)$/u;
const BABEL_CORE_DEPENDENCY = "@babel/core";
const BABEL_MAJOR_PATTERN = /^[~^]?(?<major>\d+)\./u;
const BABEL_TOOLCHAINS = [
  { expectedMajor: 7, packagePath: "apps/mobile/package.json" },
  { expectedMajor: 8, packagePath: "apps/web/package.json" },
] as const;

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
  const turboVersion = readRootTurboVersion(rootDir);
  if (turboVersion === null) {
    return [
      {
        message:
          "root package.json must define devDependencies.turbo as a concrete semver version",
        path: "package.json",
      },
    ];
  }

  const issues: WorkspaceIssue[] = [];

  for (const filePath of findTurboInstallPinFiles(rootDir)) {
    const content = readFileSync(filePath, "utf-8");
    for (const match of content.matchAll(TURBO_INSTALL_PATTERN)) {
      const installVersion = match.groups?.["version"];
      if (installVersion === turboVersion) {
        continue;
      }

      issues.push({
        message: `turbo install pin must match root package.json turbo ${turboVersion}; found ${installVersion}`,
        path: `${path.relative(rootDir, filePath)}:${lineNumberForIndex(content, match.index)}`,
      });
    }
  }

  return issues;
};

export const validateWorkspaceRoot = (rootDir: string): WorkspaceIssue[] => {
  const issues: WorkspaceIssue[] = [
    ...validateTurboInstallPins(rootDir),
    ...validateBabelToolchains(rootDir),
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
        ...validateCssImportOwnership(
          path.resolve(parentPath, entry.name),
          relativePath,
          dependencyNames,
        ),
      );
    }
  }

  return issues;
};

if (import.meta.main) {
  const issues = validateWorkspaceRoot(process.cwd());

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
