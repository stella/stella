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

/** Lists both sides of renames and all other changed paths, including deletions. */
export const changedFilesSince = (base: string): string[] => {
  const output = gitOutput([
    "diff",
    "--name-only",
    "--no-renames",
    `${base}...HEAD`,
  ]);
  if (output === undefined) {
    panic(`Cannot compare HEAD with ${base}`);
  }
  return output === "" ? [] : output.split("\n");
};
