#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const WORKSPACE_PARENT_DIRS = ["apps", "packages"] as const;

export type WorkspaceParentDir = (typeof WORKSPACE_PARENT_DIRS)[number];

export type WorkspaceIssue = {
  message: string;
  path: string;
};

type WorkspacePackageReadResult =
  | {
      name: string | undefined;
      parseFailed: false;
    }
  | {
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
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    return {
      name: undefined,
      parseFailed: true,
    };
  }

  if (!isRecord(packageJson)) {
    return {
      name: undefined,
      parseFailed: false,
    };
  }

  const maybeName = packageJson["name"];
  return {
    name: typeof maybeName === "string" ? maybeName : undefined,
    parseFailed: false,
  };
};

export const expectedWorkspaceName = (directoryName: string) =>
  `@stella/${directoryName}`;

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

      const { name: workspaceName, parseFailed } =
        readWorkspacePackage(packageJsonPath);
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
