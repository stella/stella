import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import apiPackage from "../apps/api/package.json" with { type: "json" };

const repositoryRoot = path.resolve(import.meta.dir, "..");
const infrastructurePaths = new Set([
  ".github/workflows/ci.yml",
  "scripts/detect-service-suite-changes.ts",
  "scripts/detect-service-suite-changes.test.ts",
  "scripts/ci-plan.test.ts",
  ".npmrc",
  "scripts/retry.sh",
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "docker/postgres/init.sql",
]);

const directlyRequired = (file: string) =>
  infrastructurePaths.has(file) ||
  file.startsWith("patches/") ||
  file.startsWith("apps/api/scripts/") ||
  file.startsWith("apps/api/src/scripts/") ||
  // Runtime assets may be read through fs/Glob rather than imported.
  (file.startsWith("apps/api/src/") && !/\.[cm]?[jt]sx?$/u.test(file)) ||
  (file.startsWith("apps/api/src/") && file.includes("/__fixtures__/")) ||
  file.startsWith("apps/api/src/tests/") ||
  file.startsWith("apps/collab/src/") ||
  file === "apps/api/package.json" ||
  file === "apps/api/tsconfig.json" ||
  file === "apps/api/bunfig.toml" ||
  file === "apps/collab/package.json" ||
  file === "apps/collab/tsconfig.json" ||
  file === "apps/collab/bunfig.toml" ||
  (file.startsWith("apps/api/src/") && /\.test\.[jt]sx?$/u.test(file)) ||
  file.startsWith("apps/api/drizzle/") ||
  file.startsWith("apps/api/src/db/") ||
  file.startsWith("apps/api/src/lib/db/") ||
  file.startsWith("apps/api/src/lib/scheduler/") ||
  (file.startsWith("apps/api/src/") && file.includes("backfill"));

const expandWorkspaceScopes = (packageScopes: Set<string>, root: string) => {
  // Referenced packages are units; follow their declared workspace dependencies
  // without parsing their sources or relying on installed workspace symlinks.
  const pendingPackages = [...packageScopes];
  for (const scope of pendingPackages) {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(root, scope, "package.json"), "utf-8"),
    );
    if (typeof manifest !== "object" || manifest === null) {
      return `Invalid manifest: ${scope}`;
    }
    for (const [kind, values] of Object.entries(manifest)) {
      if (
        !["dependencies", "peerDependencies", "optionalDependencies"].includes(
          kind,
        ) ||
        typeof values !== "object" ||
        values === null
      ) {
        continue;
      }
      for (const dependency of Object.keys(values)) {
        if (!dependency.startsWith("@stll/")) {
          continue;
        }
        const dependencyScope = `packages/${dependency.slice("@stll/".length)}/`;
        if (
          packageScopes.has(dependencyScope) ||
          !existsSync(path.join(root, dependencyScope, "package.json"))
        ) {
          continue;
        }
        packageScopes.add(dependencyScope);
        pendingPackages.push(dependencyScope);
      }
    }
  }
};

/** Workspace packages are scoped as units, including exports and non-code assets.
 * Local API/collaboration imports are followed file by file. No install is needed
 * in ci-plan: package discovery uses the checkout, not node_modules.
 */
export const serviceSuiteDependencies = (root = repositoryRoot) => {
  const dependencies = new Set<string>();
  const pending = [
    "apps/api/src/tests/setup-env.ts",
    ...Object.values(apiPackage.ciGateTestRunners).map(
      ({ runner }) => `apps/api/${runner}`,
    ),
    "apps/api/src/db/migrate.ts",
    "apps/collab/src/server.test.ts",
  ];
  const packageScopes = new Set<string>();
  const gates = [
    ...Object.values(apiPackage.ciGateTestRunners).map(({ gate }) => gate),
    "STELLA_RUN_CORPUS_ENGINE_TESTS",
  ];
  const testGlobs = new Set([
    ...Object.values(apiPackage.ciGateTestRunners).map(
      ({ testFileGlob }) => `apps/api/${testFileGlob}`,
    ),
    "apps/api/src/**/*.test.ts",
  ]);
  const testFiles = new Set<string>();
  for (const glob of testGlobs) {
    for (const file of new Bun.Glob(glob).scanSync({ cwd: root })) {
      testFiles.add(file);
    }
  }
  for (const file of testFiles) {
    const source = readFileSync(path.join(root, file), "utf-8");
    if (gates.some((gate) => source.includes(gate))) {
      pending.push(file);
    }
  }
  const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
  const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
  for (const file of pending) {
    if (dependencies.has(file)) {
      continue;
    }
    dependencies.add(file);
    if (!/\.[cm]?[jt]sx?$/u.test(file)) {
      continue;
    }
    const source = readFileSync(path.join(root, file), "utf-8");
    const transpiler =
      file.endsWith("tsx") || file.endsWith("jsx")
        ? tsxTranspiler
        : tsTranspiler;
    for (const { path: specifier } of transpiler.scanImports(
      source.replace(/^#![^\n]*/u, ""),
    )) {
      if (specifier.startsWith("@stll/")) {
        const name = specifier.split("/").at(1);
        const scope = `packages/${name}/`;
        if (packageScopes.has(scope)) {
          continue;
        }
        if (!existsSync(path.join(root, scope, "package.json"))) {
          // Published @stll packages are dependency inputs, covered by bun.lock.
          continue;
        }
        packageScopes.add(scope);
        continue;
      }
      let candidate: string;
      if (specifier.startsWith("@/api/")) {
        candidate = `apps/api/src/${specifier.slice("@/api/".length)}`;
      } else if (specifier.startsWith(".")) {
        candidate = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), specifier),
        );
      } else {
        continue;
      }
      const stem = candidate.replace(/\.[cm]?jsx?$/u, "");
      const resolved = [
        candidate,
        `${stem}.ts`,
        `${stem}.tsx`,
        `${candidate}.ts`,
        `${candidate}.tsx`,
        `${candidate}.js`,
        `${candidate}/index.ts`,
        `${candidate}/index.tsx`,
      ].find(
        (entry) =>
          existsSync(path.join(root, entry)) &&
          statSync(path.join(root, entry)).isFile(),
      );
      if (resolved === undefined) {
        return {
          status: "unresolved" as const,
          message: `Unresolved service-suite import: ${file}: ${specifier}`,
        };
      }
      pending.push(resolved);
    }
  }
  const packageError = expandWorkspaceScopes(packageScopes, root);
  if (packageError !== undefined) {
    return { status: "unresolved" as const, message: packageError };
  }
  for (const scope of packageScopes) {
    dependencies.add(`${scope}package.json`);
  }
  // Configuration and runner harnesses can change execution without an import.
  for (const app of ["api", "collab"]) {
    for (const file of new Bun.Glob(
      `apps/${app}/{package.json,bunfig.toml,tsconfig.json,scripts/**,src/tests/**}`,
    ).scanSync({ cwd: root })) {
      dependencies.add(file);
    }
  }
  return { status: "complete" as const, dependencies, packageScopes };
};

let defaultGraph: ReturnType<typeof serviceSuiteDependencies> | undefined;

export const requiresServiceSuites = (
  files: readonly string[],
  root = repositoryRoot,
): boolean => {
  if (files.some(directlyRequired)) {
    return true;
  }
  if (files.length === 0) {
    return false;
  }
  if (!files.some((file) => /^(apps\/(api|collab)\/|packages\/)/u.test(file))) {
    return false;
  }
  if (root === repositoryRoot) {
    defaultGraph ??= serviceSuiteDependencies(root);
  }
  const graph =
    root === repositoryRoot && defaultGraph !== undefined
      ? defaultGraph
      : serviceSuiteDependencies(root);
  switch (graph.status) {
    case "unresolved":
      console.error(graph.message);
      return true;
    case "complete":
      return files.some(
        (file) =>
          graph.dependencies.has(file) ||
          [...graph.packageScopes].some((scope) => file.startsWith(scope)),
      );
  }
};

if (import.meta.main) {
  // A missing/deleted dependency or an unreadable graph must widen the scope.
  try {
    console.log(requiresServiceSuites(process.argv.slice(2)));
  } catch (error) {
    console.error(error);
    console.log(true);
  }
}
