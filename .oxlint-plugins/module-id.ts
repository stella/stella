// Canonical module identity, so `./escape-like`, `../lib/escape-like.ts` and
// `@/api/lib/escape-like` compare equal: relative specifiers resolve against
// the importing file, the app path aliases expand to their source roots, and
// extensions and a trailing `/index` drop. Bare package specifiers pass
// through unchanged.
export const exactModuleId = (
  specifier: string,
  importerRepoPath: string,
): string => {
  let resolved = specifier;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const segments = importerRepoPath.split("/").slice(0, -1);
    for (const segment of specifier.split("/")) {
      if (segment === "..") {
        segments.pop();
      } else if (segment !== ".") {
        segments.push(segment);
      }
    }
    resolved = segments.join("/");
  } else if (specifier.startsWith("@/api/")) {
    resolved = `apps/api/src/${specifier.slice("@/api/".length)}`;
  } else if (specifier.startsWith("@/")) {
    const { app } =
      /^apps\/(?<app>[^/]+)\//u.exec(importerRepoPath)?.groups ?? {};
    if (app !== undefined) {
      resolved = `apps/${app}/src/${specifier.slice("@/".length)}`;
    }
  }
  return resolved.replace(/\.[cm]?[jt]sx?$/u, "");
};

export const canonicalModuleId = (
  specifier: string,
  importerRepoPath: string,
): string =>
  exactModuleId(specifier, importerRepoPath).replace(/\/index$/u, "");
