/**
 * Static import graph of an apps/api module, resolved through the same alias
 * the runtime uses.
 *
 * Boundary tests use it to assert that an entrypoint cannot reach a module it
 * must not require. A dynamic import counts: the scanner reports it, and an
 * environment module validates its settings the first time it evaluates,
 * whenever that is.
 */
import { existsSync, statSync } from "node:fs";
import nodePath from "node:path";

const repoRoot = new URL("../../../..", import.meta.url).pathname;

export const apiSourceRoot = nodePath.resolve(repoRoot, "apps/api/src");

const resolveApiModule = (
  importPath: string,
  importer: string,
): string | null => {
  let basePath: string;
  if (importPath.startsWith("@/api/")) {
    basePath = nodePath.resolve(
      apiSourceRoot,
      importPath.slice("@/api/".length),
    );
  } else if (importPath.startsWith(".")) {
    basePath = nodePath.resolve(nodePath.dirname(importer), importPath);
  } else {
    return null;
  }

  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    nodePath.resolve(basePath, "index.ts"),
    nodePath.resolve(basePath, "index.tsx"),
  ];
  return (
    candidates.find(
      (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
    ) ?? null
  );
};

export const collectApiModuleGraph = async (
  entrypoint: string,
  visited = new Set<string>(),
): Promise<Set<string>> => {
  if (visited.has(entrypoint)) {
    return visited;
  }
  visited.add(entrypoint);
  const source = await Bun.file(entrypoint).text();
  const loader = entrypoint.endsWith(".tsx") ? "tsx" : "ts";
  const imports = new Bun.Transpiler({ loader }).scan(source).imports;
  const dependencies = imports
    .map(({ path }) => resolveApiModule(path, entrypoint))
    .filter((path): path is string => path !== null);
  await Promise.all(
    dependencies.map(
      async (dependency) => await collectApiModuleGraph(dependency, visited),
    ),
  );
  return visited;
};
