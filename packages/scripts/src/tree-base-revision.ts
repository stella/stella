import { panic } from "better-result";

import { childExitStatus } from "./child-exit-status";

type TreeBaseRevisionOptions = {
  repoRoot: string;
  baseRef?: string | undefined;
  headRef?: string | undefined;
  env?: NodeJS.ProcessEnv;
};

/** Pin comparisons to the base of this tree, including CI's merge-group base. */
export const treeBaseRevision = ({
  repoRoot,
  baseRef,
  headRef = "HEAD",
  env = process.env,
}: TreeBaseRevisionOptions): string => {
  // Hooks may export selectors for another repository; cwd owns this Git read.
  const gitEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => !key.startsWith("GIT_") && value !== undefined,
    ),
  );
  const readGit = (args: [string, ...string[]]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: repoRoot,
      env: gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (childExitStatus(result) !== 0) {
      return panic(
        `Tree comparison base unavailable: git ${args[0]} failed (${args.join(" ")}): ${result.stderr.toString().trim()}`,
      );
    }
    return result.stdout.toString().trim();
  };
  const configured = baseRef ?? env["RATCHET_BASE_REF"];
  const revision =
    configured ?? readGit(["merge-base", "origin/main", headRef]);
  return readGit([
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${revision}^{commit}`,
  ]);
};
