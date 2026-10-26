import { panic, Result, TaggedError } from "better-result";

class RepositoryFilesError extends TaggedError("RepositoryFilesError")<{
  message: string;
}> {}

type ReadRepositoryFilesOptions = {
  root: string | URL;
  /** `worktree` adds the untracked files the ignore rules let through. */
  scope: "tracked" | "worktree";
  pathspecs?: readonly string[];
};

const SCOPE_ARGUMENTS = {
  tracked: [],
  worktree: ["--others", "--exclude-standard"],
} as const satisfies Record<ReadRepositoryFilesOptions["scope"], string[]>;

/**
 * The repository's file listing, read through `Bun.spawnSync`, which keeps the
 * whole output: `node:child_process` sync calls stop at a 1 MiB output buffer
 * by default, and the repository's listing has outgrown it.
 */
export const readRepositoryFiles = ({
  root,
  scope,
  pathspecs = [],
}: ReadRepositoryFilesOptions): Result<string[], RepositoryFilesError> => {
  const proc = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      ...SCOPE_ARGUMENTS[scope],
      "-z",
      "--",
      ...pathspecs,
    ],
    {
      cwd: root instanceof URL ? Bun.fileURLToPath(root) : root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) {
    return Result.err(
      new RepositoryFilesError({
        message: `git ls-files failed: ${proc.stderr.toString()}`,
      }),
    );
  }
  return Result.ok(proc.stdout.toString().split("\0").filter(Boolean));
};

/** Every path git tracks under `root`; a checkout without git is a defect. */
export const listTrackedFiles = (root: string | URL): string[] => {
  const files = readRepositoryFiles({ root, scope: "tracked" });
  return Result.isError(files) ? panic(files.error.message) : files.value;
};
