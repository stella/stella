#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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

      cssFiles.push(...findCssFiles(join(directoryPath, entry.name)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".css")) {
      cssFiles.push(join(directoryPath, entry.name));
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

export const validateWorkspaceRoot = (rootDir: string): WorkspaceIssue[] => {
  const issues: WorkspaceIssue[] = [];

  for (const parentDir of WORKSPACE_PARENT_DIRS) {
    const parentPath = resolve(rootDir, parentDir);
    const entries = readdirSync(parentPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .toSorted((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const relativePath = `${parentDir}/${entry.name}`;
      const packageJsonPath = resolve(parentPath, entry.name, "package.json");

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
          resolve(parentPath, entry.name),
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
