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

// Production install graph: dependencies plus optionalDependencies (platform
// binding packages ride the optional field). devDependencies never install in
// the runner; peerDependencies of an externalized package resolve against a
// consumer instance that is reachable through its own dependency edge.
const readDependencyNames = (manifest: unknown): string[] => {
  if (!isRecord(manifest)) {
    return [];
  }

  const names: string[] = [];
  for (const field of ["dependencies", "optionalDependencies"]) {
    const value = manifest[field];
    if (isRecord(value)) {
      names.push(...Object.keys(value));
    }
  }
  return names;
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

  const visited = new Set<string>();
  const runtimeWorkspaces = new Set<string>();

  // Bun stores a dependency at a consumer-scoped key ("parent/name", chained
  // for deeper conflicts) when its resolution differs from the hoisted one.
  // Resolve the deepest matching key for this consumer chain first, so the
  // walk follows the copy this consumer actually gets, not the hoisted one.
  const entryKeyFor = (name: string, parentChain: string[]): string => {
    for (let index = 0; index < parentChain.length; index += 1) {
      const candidate = [...parentChain.slice(index), name].join("/");
      if (candidate in packages) {
        return candidate;
      }
    }
    return name;
  };

  const chainFromKey = (
    entryKey: string,
    name: string,
    parentChain: string[],
  ): string[] => {
    for (let index = 0; index < parentChain.length; index += 1) {
      const candidate = [...parentChain.slice(index), name];
      if (candidate.join("/") === entryKey) {
        return candidate;
      }
    }
    return [name];
  };

  const visit = (name: string, parentChain: string[]): void => {
    const entryKey = entryKeyFor(name, parentChain);
    if (visited.has(entryKey)) {
      return;
    }
    visited.add(entryKey);

    const entry = packages[entryKey];
    if (!Array.isArray(entry)) {
      return;
    }
    const resolution = entry.at(0);
    if (typeof resolution !== "string") {
      throw new TypeError(`bun.lock package ${entryKey} has no resolution`);
    }

    // The chain that reproduces this entry's key, so children resolve their
    // own consumer-scoped copies beneath it.
    const childChain =
      entryKey === name ? [name] : chainFromKey(entryKey, name, parentChain);

    const workspaceMarker = "@workspace:";
    const markerIndex = resolution.indexOf(workspaceMarker);
    if (markerIndex !== -1) {
      const workspacePath = resolution.slice(
        markerIndex + workspaceMarker.length,
      );
      runtimeWorkspaces.add(workspacePath);
      for (const child of readDependencyNames(workspaces[workspacePath])) {
        visit(child, childChain);
      }
      return;
    }

    for (const child of readDependencyNames(entry.at(2))) {
      visit(child, childChain);
    }
  };

  // Seed with the web app's external dependencies only: @stll/web's own
  // workspace dependencies are bundled into dist by Vite, so their sources
  // never need to exist in the runner. Seeds resolve in the web consumer
  // context too — Bun can store a web dependency under "<web name>/<dep>"
  // when its resolution differs from the hoisted copy.
  const webWorkspace = workspaces["apps/web"];
  if (!isRecord(webWorkspace) || typeof webWorkspace["name"] !== "string") {
    throw new TypeError("bun.lock apps/web workspace must have a name");
  }
  const webChain = [webWorkspace["name"]];
  const isWorkspaceResolved = (name: string): boolean => {
    const entry = packages[entryKeyFor(name, webChain)];
    return (
      Array.isArray(entry) &&
      typeof entry.at(0) === "string" &&
      String(entry.at(0)).includes("@workspace:")
    );
  };
  for (const name of readDependencyNames(webWorkspace)) {
    if (!isWorkspaceResolved(name)) {
      visit(name, webChain);
    }
  }

  return [...runtimeWorkspaces].sort();
};
