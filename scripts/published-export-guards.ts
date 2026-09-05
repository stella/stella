import path from "node:path";

const testArtifactPattern =
  /(?:^|\/)(?:fixtures\/|[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|d\.ts)$|[^/]+\.playwright\.[cm]?[jt]sx?$|playwright\.config\.[cm]?[jt]sx?$)/u;

export const isPublishedTestArtifact = (file: string) =>
  testArtifactPattern.test(file);

/**
 * Containment by path segment, not by string prefix: `dist-cache` starts with
 * `dist` but is a different directory.
 */
const isInsideDirectory = (candidate: string, directory: string): boolean => {
  const relative = path.relative(directory, path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/**
 * Whether a Node load failure is the tarball's own defect.
 *
 * Node's ESM resolver is what decides whether a published package loads for a
 * consumer, and it is stricter than Bun's: Bun fills in an omitted relative
 * extension, so `export * from "./thing"` passes there and fails on install.
 * That is the hole worth failing on. In-repo, though, Node also walks outside
 * the package under test — a workspace dependency still exports TypeScript
 * source here, a third-party export map may use a directory import, a
 * Bun-targeted package imports `bun` — and none of those is decided by this
 * tarball. So a failure counts only when the specifier Node could not reach
 * lives in the package's own `dist`.
 *
 * Node phrases these as "<target> imported from <importer>"; the target is the
 * half that names what could not be resolved. It is prose around a path, so
 * the path is recovered by splitting on the quotes and spaces that surround it.
 */
export const isOwnDistLoadFailure = ({
  distDir,
  reason,
}: {
  readonly distDir: string;
  readonly reason: string;
}): boolean => {
  const [target] = reason.split(" imported from ");
  return (
    target
      ?.split(/["'\s]+/u)
      .some(
        (token) => path.isAbsolute(token) && isInsideDirectory(token, distDir),
      ) === true
  );
};

type PublishedExportEntry = string | { readonly import: string };

export const isExpectedPublishedExportResolution = ({
  entry,
  packageDir,
  resolved,
}: {
  readonly entry: PublishedExportEntry;
  readonly packageDir: string;
  readonly resolved: string;
}): boolean => {
  if (typeof entry === "string") {
    return path.resolve(resolved) === path.resolve(packageDir, entry);
  }

  return isInsideDirectory(resolved, path.resolve(packageDir, "dist"));
};
