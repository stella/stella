import nodePath from "node:path";

type PathApi = Pick<
  typeof nodePath,
  "isAbsolute" | "relative" | "resolve" | "sep"
>;

/** Returns a repository-relative identifier with forward-slash separators. */
export const repoRelativePath = (
  root: string,
  file: string,
  pathApi: PathApi = nodePath,
): string => pathApi.relative(root, file).replaceAll(pathApi.sep, "/");

/** Reports whether a candidate resolves to the root or one of its descendants. */
export const isPathInside = (
  root: string,
  candidate: string,
  pathApi: PathApi = nodePath,
): boolean => {
  const relative = pathApi.relative(
    pathApi.resolve(root),
    pathApi.resolve(candidate),
  );
  return (
    !pathApi.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`)
  );
};
