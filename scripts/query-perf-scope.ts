import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const registry = "apps/api/src/tests/query-perf/registry.ts";

export const queryPerfDependencies = (
  repositoryRoot = root,
):
  | { status: "complete"; files: Set<string> }
  | { status: "unresolved"; reason: string } => {
  if (!existsSync(path.join(repositoryRoot, registry))) {
    return {
      status: "unresolved",
      reason: `Missing query performance registry: ${registry}`,
    };
  }
  const files = new Set<string>();
  const pending = [registry];
  const tsTranspiler = new Bun.Transpiler({ loader: "ts" });
  const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || files.has(file)) {
      continue;
    }
    files.add(file);
    if (!/\.[cm]?[jt]sx?$/u.test(file)) {
      continue;
    }
    const source = readFileSync(path.join(repositoryRoot, file), "utf-8");
    const transpiler = /\.[jt]sx$/u.test(file) ? tsxTranspiler : tsTranspiler;
    for (const { path: specifier } of transpiler.scanImports(
      source.replace(/^#![^\n]*/u, ""),
    )) {
      if (specifier.startsWith("@stll/")) {
        continue;
      }
      if (!specifier.startsWith(".") && !specifier.startsWith("@/api/")) {
        continue;
      }
      const candidate = specifier.startsWith("@/api/")
        ? `apps/api/src/${specifier.slice("@/api/".length)}`
        : path.posix.normalize(
            path.posix.join(path.posix.dirname(file), specifier),
          );
      const stem = candidate.replace(/\.[cm]?[jt]sx?$/u, "");
      const resolved = [
        candidate,
        `${stem}.ts`,
        `${stem}.tsx`,
        `${stem}.js`,
        `${stem}.json`,
        `${stem}/index.ts`,
      ].find(
        (entry) =>
          existsSync(path.join(repositoryRoot, entry)) &&
          statSync(path.join(repositoryRoot, entry)).isFile(),
      );
      if (resolved === undefined) {
        return {
          status: "unresolved",
          reason: `Unresolved query performance import: ${file}: ${specifier}`,
        };
      }
      pending.push(resolved);
    }
  }
  return { status: "complete", files };
};

export const queryPerfRequired = (
  changed: readonly string[],
  unknown = false,
  repositoryRoot = root,
): boolean => {
  if (unknown) {
    return true;
  }
  if (
    changed.some(
      (file) =>
        file.startsWith("apps/api/drizzle/") ||
        file.startsWith("apps/api/src/db/") ||
        file.startsWith("apps/api/src/tests/query-perf/") ||
        file.startsWith("scripts/query-perf") ||
        file.startsWith("scripts/query-perf-allowances/") ||
        file.startsWith("packages/") ||
        [
          "apps/api/package.json",
          "apps/api/bunfig.toml",
          "apps/api/src/tests/setup-env.ts",
          "apps/api/src/tests/test-database-environment.ts",
          "apps/api/src/tests/gated-test-database.ts",
          "apps/api/src/tests/explain-as-stella.ts",
          "apps/api/scripts/run-perf-tests.ts",
          ".github/workflows/ci.yml",
          ".github/workflows/query-perf.yml",
          "bun.lock",
          "package.json",
          "bunfig.toml",
        ].includes(file) ||
        /(?:^|\/)(?:rls|polic(?:y|ies))\//iu.test(file) ||
        /(?:^|\/)(?:schema|rls|policy)[^/]*\.(?:ts|sql)$/iu.test(file) ||
        /^tsconfig(?:\.[^/]+)?\.json$/u.test(file),
    )
  ) {
    return true;
  }
  const graph = queryPerfDependencies(repositoryRoot);
  if (graph.status === "unresolved") {
    return true;
  }
  return changed.some((file) => graph.files.has(file));
};

if (import.meta.main) {
  const input = process.env.QUERY_PERF_CHANGED_PATHS;
  const unknown = process.env.QUERY_PERF_SCOPE_UNKNOWN === "true";
  try {
    let changed: string[] = [];
    if (input === undefined) {
      changed = process.argv.slice(2);
    } else if (!unknown) {
      changed = readFileSync(input)
        .toString("utf-8")
        .split("\0")
        .filter(Boolean);
    }
    console.log(`query_perf_required=${queryPerfRequired(changed, unknown)}`);
  } catch {
    console.log("query_perf_required=true");
  }
}
