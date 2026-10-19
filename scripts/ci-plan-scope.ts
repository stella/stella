import { panic } from "better-result";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

type ChangedFilesOptions = {
  root: string;
  base: string;
  head: string;
};

/** Read the exact no-renames path set used by changed-file CI planning. */
export const changedFilesForCiPlan = ({
  root,
  base,
  head,
}: ChangedFilesOptions): string[] => {
  const result = Bun.spawnSync(
    ["git", "diff", "--name-only", "-z", "--no-renames", base, head],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  if (childExitStatus(result) !== 0) {
    panic(
      `Unable to read CI plan range ${base}..${head}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((file) => file.length > 0);
};

/** The API scope is selected whenever its owned source tree changed. */
export const selectsApiScope = (changedFiles: readonly string[]): boolean =>
  changedFiles.some((file) => file.startsWith("apps/api/"));
