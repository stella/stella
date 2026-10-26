import { panic } from "better-result";

const gitOutput = (args: readonly string[]): string | undefined => {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
};

const commitExists = (revision: string): boolean =>
  Bun.spawnSync(["git", "cat-file", "-e", `${revision}^{commit}`], {
    stdout: "ignore",
    stderr: "ignore",
  }).exitCode === 0;

/** Returns CI's exact planned base, or the pull-request merge base when available. */
export const comparisonBase = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const planned = environment["CI_COMPARISON_BASE"]?.trim();
  if (planned && commitExists(planned)) {
    return planned;
  }
  const baseRef = environment["GITHUB_BASE_REF"]?.trim();
  return baseRef
    ? gitOutput(["merge-base", "HEAD", `origin/${baseRef}`])
    : undefined;
};

/**
 * Lists both sides of renames and all other changed paths, including
 * deletions. NUL-separated output keeps every path exactly as it is: the
 * line form quotes paths with non-ASCII characters, tabs or newlines.
 */
export const changedFilesSince = (base: string): string[] => {
  const result = Bun.spawnSync(
    ["git", "diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (result.exitCode !== 0) {
    panic(`Cannot compare HEAD with ${base}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => file !== "");
};
