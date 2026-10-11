import { panic } from "better-result";

// The preload imports this owner before denying general subprocess access.
// Keep the captured primitive private: callers can only read baseline objects.
const spawnGit = Bun.spawnSync.bind(Bun);

type ReadGitBaselineOptions = {
  root: string;
  base: string;
  file: string;
};

export const readGitBaseline = ({
  root,
  base,
  file,
}: ReadGitBaselineOptions): string | undefined => {
  const options = {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    // Object reads in partial clones must fail locally rather than fetch.
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  } as const;
  const mergeBase = spawnGit(
    ["git", "merge-base", "--end-of-options", "HEAD", base],
    options,
  );
  if (mergeBase.exitCode !== 0) {
    return panic(
      `Cannot resolve baseline ${base}: ${mergeBase.stderr.toString()}`,
    );
  }
  const revision = mergeBase.stdout.toString().trim();
  const tree = spawnGit(
    ["git", "ls-tree", "--name-only", revision, "--", file],
    options,
  );
  if (tree.exitCode !== 0) {
    return panic(
      `Cannot inspect classification baseline: ${tree.stderr.toString()}`,
    );
  }
  if (tree.stdout.toString().trim() === "") {
    return undefined;
  }
  const baseline = spawnGit(["git", "show", `${revision}:${file}`], options);
  if (baseline.exitCode !== 0) {
    return panic(
      `Cannot read classification baseline: ${baseline.stderr.toString()}`,
    );
  }
  return baseline.stdout.toString();
};
