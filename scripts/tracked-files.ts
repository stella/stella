import { panic } from "better-result";

/**
 * Every path git tracks under `root`. Read through `Bun.spawnSync`, which keeps
 * the whole listing: `node:child_process` sync calls stop at a 1 MiB output
 * buffer, and the repository's listing has outgrown it.
 */
export const listTrackedFiles = (root: string): string[] => {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    panic(`git ls-files failed in ${root}: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
};
