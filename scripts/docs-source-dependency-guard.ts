import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { DOC_SOURCES } from "../.claude/mcp/doc-sources";

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const readManifestDependencies = (manifestPath: string): string[] => {
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf-8"),
  ) as PackageManifest;
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
};

const getWorkspaceManifestPaths = (root: string): string[] => {
  const manifests = [path.join(root, "package.json")];
  for (const workspaceRoot of ["apps", "packages"]) {
    const directory = path.join(root, workspaceRoot);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifest = path.join(directory, entry.name, "package.json");
      if (existsSync(manifest)) {
        manifests.push(manifest);
      }
    }
  }
  return manifests;
};

export const findUndeclaredDocSourceDependencies = (
  declaredDependencies: ReadonlySet<string>,
): string[] =>
  Object.entries(DOC_SOURCES)
    .filter(([, source]) => !declaredDependencies.has(source.dependency))
    .map(([name, source]) => `${name}: ${source.dependency}`);

export const checkDocSourceDependencies = (root: string): string[] => {
  const declaredDependencies = new Set(
    getWorkspaceManifestPaths(root).flatMap(readManifestDependencies),
  );
  return findUndeclaredDocSourceDependencies(declaredDependencies);
};

if (import.meta.main) {
  const failures = checkDocSourceDependencies(
    path.resolve(import.meta.dir, ".."),
  );
  if (failures.length > 0) {
    console.error(
      `Documentation sources without a declared workspace dependency:\n${failures
        .map((failure) => `  ${failure}`)
        .join("\n")}`,
    );
    process.exit(1);
  }
  console.log("Documentation sources match declared workspace dependencies.");
}
