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

type ContainmentOptions = {
  root: string;
  candidate: string;
  pathApi: PathApi;
  boundary: "inclusive" | "strict";
};

const containsPath = ({
  root,
  candidate,
  pathApi,
  boundary,
}: ContainmentOptions): boolean => {
  const relative = pathApi.relative(
    pathApi.resolve(root),
    pathApi.resolve(candidate),
  );
  return (
    (boundary === "inclusive" || relative !== "") &&
    !pathApi.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`)
  );
};

/** Reports whether a candidate resolves to the root or one of its descendants. */
export const isPathInside = (
  root: string,
  candidate: string,
  pathApi: PathApi = nodePath,
): boolean => containsPath({ root, candidate, pathApi, boundary: "inclusive" });

/** Reports strict descent, excluding equality under the platform's path semantics. */
export const isPathStrictlyInside = (
  root: string,
  candidate: string,
  pathApi: PathApi = nodePath,
): boolean => containsPath({ root, candidate, pathApi, boundary: "strict" });
