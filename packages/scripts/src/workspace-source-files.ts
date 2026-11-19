import { execFileSync } from "node:child_process";

// Ignored build outputs can be replaced by concurrent generators. Git owns the
// source inventory, including new local files and tracked generated sources.
export const workspaceSources = (directory: string) => {
  const deleted = new Set(
    execFileSync(
      "git",
      ["ls-files", "--deleted", "-z", "--", "apps", "packages"],
      {
        cwd: directory,
        encoding: "utf-8",
        maxBuffer: 8 * 1024 * 1024,
      },
    ).split("\0"),
  );
  return execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "apps",
      "packages",
    ],
    { cwd: directory, encoding: "utf-8", maxBuffer: 8 * 1024 * 1024 },
  )
    .split("\0")
    .filter(
      (file) =>
        !deleted.has(file) &&
        /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u.test(file),
    );
};
