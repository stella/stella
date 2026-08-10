// Derive, from bun.lock, the workspace packages that externalized npm
// dependencies of @stll/web import at runtime.
//
// The SSR server bundle externalizes npm packages; when such a package (e.g.
// @stll/folio-core) declares a dependency whose name matches a local
// workspace, Bun links the workspace instead of the registry copy. Every
// workspace reached that way must exist inside the runner image in a
// runtime-loadable shape. scripts/stage-web-runtime.ts stages that closure;
// scripts/stage-web-runtime.test.ts guards the derivation.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readDependencyNames = (manifest: unknown): string[] => {
  if (!isRecord(manifest)) {
    return [];
  }

  const dependencies = manifest["dependencies"];
  return isRecord(dependencies) ? Object.keys(dependencies) : [];
};

type ResolvedPackage = {
  dependencyNames: string[];
  workspacePath: string | undefined;
};

export const findExternalRuntimeWorkspacePaths = (
  source: unknown,
): string[] => {
  if (!isRecord(source)) {
    throw new TypeError("bun.lock must contain an object");
  }

  const packages = source["packages"];
  const workspaces = source["workspaces"];
  if (!isRecord(packages) || !isRecord(workspaces)) {
    throw new TypeError("bun.lock must contain packages and workspaces maps");
  }

  const resolvePackage = (name: string): ResolvedPackage | undefined => {
    const entry = packages[name];
    if (!Array.isArray(entry)) {
      return undefined;
    }

    const resolution = entry.at(0);
    if (typeof resolution !== "string") {
      throw new TypeError(`bun.lock package ${name} has no resolution`);
    }

    const workspaceMarker = "@workspace:";
    const markerIndex = resolution.indexOf(workspaceMarker);
    if (markerIndex !== -1) {
      const workspacePath = resolution.slice(
        markerIndex + workspaceMarker.length,
      );
      return {
        dependencyNames: readDependencyNames(workspaces[workspacePath]),
        workspacePath,
      };
    }

    return {
      dependencyNames: readDependencyNames(entry.at(2)),
      workspacePath: undefined,
    };
  };

  const webWorkspace = workspaces["apps/web"];
  const queue = readDependencyNames(webWorkspace).filter(
    (name) => resolvePackage(name)?.workspacePath === undefined,
  );
  const visited = new Set<string>();
  const runtimeWorkspaces = new Set<string>();

  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || visited.has(name)) {
      continue;
    }
    visited.add(name);

    const resolved = resolvePackage(name);
    if (!resolved) {
      continue;
    }
    if (resolved.workspacePath) {
      runtimeWorkspaces.add(resolved.workspacePath);
    }
    queue.push(...resolved.dependencyNames);
  }

  return [...runtimeWorkspaces].sort();
};
