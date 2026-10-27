import { readFileSync } from "node:fs";
import path from "node:path";

const DEPENDENCY_GROUPS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const SCOPE = "@stll/";

class PublishPackageOrderError extends Error {
  readonly _tag = "PublishPackageOrderError";

  constructor(message: string) {
    super(message);
    this.name = "PublishPackageOrderError";
  }
}

export type PublishManifest = {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
};

const packageDirectory = (packageName: string): string =>
  packageName.slice(SCOPE.length);

/** Return selected packages and their published workspace dependencies in topological order. */
export const publicationOrder = (
  manifests: readonly PublishManifest[],
  selected: readonly string[],
): readonly string[] => {
  const byDirectory = new Map(
    manifests.map((manifest) => [packageDirectory(manifest.name), manifest]),
  );
  const selectedSet = new Set(selected);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: string[] = [];

  const visit = (directory: string): void => {
    if (visited.has(directory)) {
      return;
    }
    if (visiting.has(directory)) {
      throw new PublishPackageOrderError(
        `Published workspace dependency cycle at ${directory}`,
      );
    }
    const manifest = byDirectory.get(directory);
    if (manifest === undefined) {
      throw new PublishPackageOrderError(
        `Unknown published package '${directory}'`,
      );
    }
    visiting.add(directory);
    for (const group of DEPENDENCY_GROUPS) {
      for (const dependency of Object.keys(manifest[group] ?? {}).toSorted()) {
        if (!dependency.startsWith(SCOPE)) {
          continue;
        }
        const dependencyDirectory = packageDirectory(dependency);
        if (byDirectory.has(dependencyDirectory)) {
          visit(dependencyDirectory);
        }
      }
    }
    visiting.delete(directory);
    visited.add(directory);
    ordered.push(directory);
  };

  for (const selectedDirectory of manifests
    .map(({ name }) => packageDirectory(name))
    .filter((directory) => selectedSet.has(directory))
    .toSorted()) {
    visit(selectedDirectory);
  }
  for (const directory of selected) {
    if (!byDirectory.has(directory)) {
      visit(directory);
    }
  }
  return ordered;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const readManifest = (directory: string): PublishManifest => {
  const parsed: unknown = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "packages", directory, "package.json"),
      "utf-8",
    ),
  );
  if (typeof parsed !== "object" || parsed === null) {
    throw new PublishPackageOrderError(
      `packages/${directory}/package.json is not an object`,
    );
  }
  if (!("name" in parsed) || typeof parsed.name !== "string") {
    throw new PublishPackageOrderError(
      `packages/${directory}/package.json has no package name`,
    );
  }
  const manifest: PublishManifest = { name: parsed.name };
  for (const group of DEPENDENCY_GROUPS) {
    const dependencies: unknown = Reflect.get(parsed, group);
    if (typeof dependencies === "object" && dependencies !== null) {
      Object.assign(manifest, { [group]: dependencies });
    }
  }
  return manifest;
};
const readPublishedDirectories = (): readonly string[] => {
  const policy: unknown = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "scripts", "changeset-policy.json"),
      "utf-8",
    ),
  );
  if (
    typeof policy !== "object" ||
    policy === null ||
    !("releasePaths" in policy) ||
    !Array.isArray(policy.releasePaths) ||
    !policy.releasePaths.every(
      (releasePath): releasePath is string => typeof releasePath === "string",
    )
  ) {
    throw new PublishPackageOrderError(
      "scripts/changeset-policy.json has no string releasePaths array; repair the publish policy before publishing.",
    );
  }
  return [
    ...new Set(
      policy.releasePaths.flatMap((releasePath) => {
        const match = /^packages\/([^/]+)\//u.exec(releasePath);
        return match?.at(1) ?? [];
      }),
    ),
  ];
};

// The registry journeys run from a deliberately sparse checkout. Keep their
// package census dependency-free; the selection test binds it to the policy.
export const ALL_PACKAGE_ORDER = [
  "country-codes",
  "conditions",
  "template-conditions",
  "text-normalize",
  "agent-input",
  "ai-catalog",
  "anonymize-chat",
  "auth-model",
  "business-registries",
  "money",
  "calculations",
  "ui",
  "chat",
  "stable-stringify",
  "cli",
  "docx-utils",
  "fetch",
  "mcp-kit",
  "scan-engine",
  "ssr-kit",
  "ssr-testkit",
  "start-runtime",
  "workspace-model",
  "workspace-ui",
] as const;
export const LIBRARY_PACKAGE_ORDER = ALL_PACKAGE_ORDER.filter(
  (directory) => directory !== "cli",
);
export const dependenciesFirst = (selected: readonly string[]) => {
  const publishedDirectories = readPublishedDirectories();
  return publicationOrder(publishedDirectories.map(readManifest), selected);
};

// Packages whose releases moved to another repository, by package directory,
// with that repository as `github.com/<owner>/<name>`. The journey canary
// accepts npm's latest for one of these only with npm-verified provenance
// from exactly this repository; any other repository declaration falls back
// to the exact version comparison.
// None at present: @stll/time left the package order when its releases moved
// to stella/tooling.
export const MOVED_PACKAGE_REPOSITORIES: Partial<Record<string, string>> = {};
