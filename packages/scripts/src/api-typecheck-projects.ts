import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { apiTestPartitionIssues } from "./api-typecheck-partition";
import { withoutTsgoOnlyOptionDiagnostics } from "./tsgo-compiler-options";

type ProjectMembership = {
  project: string;
  files: readonly string[];
};

export const typecheckOwnershipIssues = (
  sources: readonly string[],
  projects: readonly ProjectMembership[],
) => {
  const owners = new Map<string, string[]>();
  for (const { project, files } of projects) {
    for (const file of files) {
      const existing = owners.get(file);
      if (existing) {
        existing.push(project);
      } else {
        owners.set(file, [project]);
      }
    }
  }
  return sources.flatMap((file) => {
    const projectsForFile = owners.get(file) ?? [];
    if (projectsForFile.length === 1) {
      return [];
    }
    return [
      {
        path: file,
        message: `Expected exactly one API typecheck project, found ${projectsForFile.length}: ${projectsForFile.join(", ")}`,
      },
    ];
  });
};

// Root membership comes from the compiler config parser, including inherited
// includes/excludes. Imported dependencies do not become a second file owner.
export const validateApiTypecheckProjects = (rootDir: string) => {
  const apiDir = path.join(rootDir, "apps/api");
  if (!existsSync(path.join(apiDir, "package.json"))) {
    return [];
  }
  const manifest = JSON.parse(
    readFileSync(path.join(apiDir, "package.json"), "utf-8"),
  );
  const memberships: ProjectMembership[] = [];
  const issues: { path: string; message: string }[] = [];
  for (const [name, command] of Object.entries(manifest.scripts)) {
    if (!name.startsWith("typecheck:") || typeof command !== "string") {
      continue;
    }
    if (!command.startsWith("bun check ")) {
      continue;
    }
    const project = /--project=([^\s]+)/u.exec(command)?.[1];
    if (!project) {
      issues.push({
        path: "apps/api/package.json",
        message: `${name} must name its project`,
      });
      continue;
    }
    const configPath = path.join(apiDir, project);
    const read = ts.readConfigFile(configPath, (filename) =>
      ts.sys.readFile(filename),
    );
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      apiDir,
      undefined,
      configPath,
    );
    const diagnostics = withoutTsgoOnlyOptionDiagnostics(
      read.error ? [read.error, ...parsed.errors] : parsed.errors,
    );
    for (const diagnostic of diagnostics) {
      issues.push({
        path: configPath,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      });
    }
    memberships.push({ project, files: parsed.fileNames });
  }
  const sources = ts.sys.readDirectory(
    apiDir,
    [".ts", ".tsx", ".mts", ".cts"],
    ["**/node_modules/**", "**/.cache/**", "**/.turbo/**", "**/dist/**"],
  );
  issues.push(...typecheckOwnershipIssues(sources, memberships));
  if (existsSync(path.join(apiDir, "tsconfig.declarations.json"))) {
    issues.push(...apiTestPartitionIssues(rootDir));
  }
  return issues;
};
