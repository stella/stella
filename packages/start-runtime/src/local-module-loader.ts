import { Result, TaggedError } from "better-result";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class LocalModuleLoadError extends TaggedError("LocalModuleLoadError")<{
  code: "invalid-path" | "resolution-failed" | "module-failed";
  message: string;
  cause?: unknown;
}> {}

type LoadLocalModuleOptions = { root: string; modulePath: string };

type PathContainmentOptions = { root: string; target: string };

const isWithinRoot = ({ root, target }: PathContainmentOptions) => {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

/** Roots contain trusted code; entry-path containment does not sandbox its execution. */
export const loadLocalModule = async ({
  root,
  modulePath,
}: LoadLocalModuleOptions) => {
  const target = path.resolve(root, modulePath);
  if (modulePath.split(/[/\\]/u).includes("..")) {
    return Result.err(
      new LocalModuleLoadError({
        code: "invalid-path",
        message: "Local modules must stay inside their declared root.",
      }),
    );
  }
  const resolved = await Result.tryPromise({
    try: async () => await Promise.all([realpath(root), realpath(target)]),
    catch: (cause) =>
      new LocalModuleLoadError({
        code: "resolution-failed",
        message: "Cannot resolve the local module path.",
        cause,
      }),
  });
  if (resolved.isErr()) {
    return Result.err(resolved.error);
  }
  const [rootPath, targetPath] = resolved.value;
  if (!isWithinRoot({ root: rootPath, target: targetPath })) {
    return Result.err(
      new LocalModuleLoadError({
        code: "invalid-path",
        message:
          "Local module paths must stay inside their declared real root.",
      }),
    );
  }
  const info = await Result.tryPromise({
    try: async () => await Promise.all([stat(rootPath), stat(targetPath)]),
    catch: (cause) =>
      new LocalModuleLoadError({
        code: "resolution-failed",
        message: "Cannot inspect the local module path.",
        cause,
      }),
  });
  if (info.isErr()) {
    return Result.err(info.error);
  }
  const [rootInfo, targetInfo] = info.value;
  if (!rootInfo.isDirectory() || !targetInfo.isFile()) {
    return Result.err(
      new LocalModuleLoadError({
        code: "invalid-path",
        message:
          "Local module roots must be directories and targets must be files.",
      }),
    );
  }
  return await Result.tryPromise({
    try: async (): Promise<unknown> =>
      await import(pathToFileURL(targetPath).href),
    catch: (cause) =>
      new LocalModuleLoadError({
        code: "module-failed",
        message: "Cannot evaluate the local module.",
        cause,
      }),
  });
};
