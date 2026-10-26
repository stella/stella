import { panic } from "better-result";
import { fileURLToPath } from "node:url";

/**
 * Paths `git ls-files -z` lists under `cwd`, with any further `ls-files`
 * options (`--others`, `--exclude-standard`, pathspecs).
 *
 * The repository's path list is larger than the 1 MiB that Node's sync
 * `child_process` calls capture by default, so a listing through them fails
 * with ENOBUFS (or, unchecked, reads as an empty or partial repository). Bun
 * captures the whole output; a failed listing panics with git's own message.
 */
export const listedPaths = (
  cwd: string | URL,
  options: readonly string[] = [],
): string[] => {
  const directory = typeof cwd === "string" ? cwd : fileURLToPath(cwd);
  const result = Bun.spawnSync(["git", "ls-files", "-z", ...options], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    return panic(
      `git ls-files ${options.join(" ")} failed in ${directory} (exit ${String(result.exitCode)}): ${result.stderr.toString().trim() || "no output"}`,
    );
  }
  return result.stdout.toString().split("\0").filter(Boolean);
};
