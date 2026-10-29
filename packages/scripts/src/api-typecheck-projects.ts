import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { API } from "tsrs/unstable/async";

import { repoRelativePath } from "@stll/portable-path";

import {
  apiTypecheckArtifact,
  usesGeneratedApiConfig,
} from "./api-typecheck-config";
import { apiTestPartitionIssues } from "./api-typecheck-partition";

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

const GENERATED_API_CONFIG_WRAPPERS = [
  "tsconfig.declarations.json",
  "tsconfig.src.json",
  "tsconfig.tests.json",
] as const;

// The API compiler projects extend configs that the declaration generator
// writes under .cache. A fresh install (the root postinstall runs workspace
// hygiene) has not generated them yet, so ownership cannot be resolved there.
export const missingPreparedApiTypecheckConfigs = (rootDir: string) => {
  const apiDir = path.join(rootDir, "apps/api");
  const generated = GENERATED_API_CONFIG_WRAPPERS.some((wrapper) => {
    const file = path.join(apiDir, wrapper);
    return existsSync(file) && usesGeneratedApiConfig(file);
  });
  if (!generated) {
    return [];
  }
  return (["roots", "src", "tests"] as const)
    .map((name) => apiTypecheckArtifact(apiDir, name))
    .filter((artifact) => !existsSync(artifact))
    .map((artifact) => repoRelativePath(rootDir, artifact));
};

// Root membership comes from the compiler config parser, including inherited
// includes/excludes. Imported dependencies do not become a second file owner.
// Without prepared configs the check is skipped unless `requirePrepared` is
// set; CI sets it after generating the configs, so ownership stays enforced.
export const validateApiTypecheckProjects = async (
  rootDir: string,
  { requirePrepared = false }: { requirePrepared?: boolean } = {},
) => {
  const apiDir = path.join(rootDir, "apps/api");
  if (!existsSync(path.join(apiDir, "package.json"))) {
    return [];
  }
  const missing = missingPreparedApiTypecheckConfigs(rootDir);
  if (missing.length > 0) {
    return requirePrepared
      ? [
          {
            path: "apps/api/.cache/typecheck-declarations",
            message: `prepared API typecheck configs are missing (${missing.join(", ")}); run bun --filter @stll/api generate:typecheck-declarations first`,
          },
        ]
      : [];
  }
  const manifest = JSON.parse(
    readFileSync(path.join(apiDir, "package.json"), "utf-8"),
  );
  const memberships: ProjectMembership[] = [];
  const issues: { path: string; message: string }[] = [];
  const compiler = new API({ cwd: apiDir });
  try {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (!name.startsWith("typecheck:") || typeof command !== "string") {
        continue;
      }
      if (!command.includes("bun check ")) {
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
      const parsed = await compiler.parseConfigFile(configPath);
      const diagnostics = parsed.errors;
      for (const diagnostic of diagnostics) {
        issues.push({
          path: configPath,
          message: diagnostic.text,
        });
      }
      memberships.push({ project, files: parsed.fileNames });
    }
  } finally {
    await compiler.close();
  }
  const sources = [
    ...new Bun.Glob("**/*.{ts,tsx,mts,cts}").scanSync({ cwd: apiDir }),
  ]
    .filter(
      (file) =>
        !/(?:^|\/)(?:node_modules|\.cache|\.turbo|dist)(?:\/|$)/u.test(file),
    )
    .map((file) => path.join(apiDir, file))
    .toSorted();
  issues.push(...typecheckOwnershipIssues(sources, memberships));
  if (existsSync(path.join(apiDir, "tsconfig.declarations.json"))) {
    issues.push(...(await apiTestPartitionIssues(rootDir)));
  }
  return issues;
};
