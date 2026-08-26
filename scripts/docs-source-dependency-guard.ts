import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { DOC_SOURCES } from "../.claude/mcp/doc-sources";

const readDependencyNames = (value: unknown): string[] =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value)
    : [];

const readManifestDependencies = (manifestPath: string): string[] => {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (typeof manifest !== "object" || manifest === null) {
    return [];
  }
  return [
    ...readDependencyNames(
      "dependencies" in manifest ? manifest.dependencies : undefined,
    ),
    ...readDependencyNames(
      "devDependencies" in manifest ? manifest.devDependencies : undefined,
    ),
  ];
};

const getDependencyManifestPaths = (root: string): string[] => {
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

const findUndeclaredDocSourceDependencies = (
  declaredDependencies: ReadonlySet<string>,
): string[] =>
  Object.entries(DOC_SOURCES)
    .filter(([, source]) => !declaredDependencies.has(source.dependency))
    .map(([name, source]) => `${name}: ${source.dependency}`);

export const getDeclaredDocSourceDependencies = (root: string) =>
  new Set(getDependencyManifestPaths(root).flatMap(readManifestDependencies));

export const checkDocSourceDependencies = (root: string): string[] => {
  const declaredDependencies = getDeclaredDocSourceDependencies(root);
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
