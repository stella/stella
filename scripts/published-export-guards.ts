import path from "node:path";

const testArtifactPattern =
  /(?:^|\/)(?:fixtures\/|[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|d\.ts)$|[^/]+\.playwright\.[cm]?[jt]sx?$|playwright\.config\.[cm]?[jt]sx?$)/u;

export const isPublishedTestArtifact = (file: string) =>
  testArtifactPattern.test(file);

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

  const distDir = path.resolve(packageDir, "dist");
  const relative = path.relative(distDir, path.resolve(resolved));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};
