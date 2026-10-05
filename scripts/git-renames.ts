// Baselines and ledgers keyed by file path must follow a moved file: a pure
// move re-keys its existing entries, and an only-shrinks guard that compares
// raw keys reads them as new.
import { panic } from "better-result";

type ReadRenamesOptions = { baseRef: string; repoRoot: string };

/** Files moved since `baseRef`, old path to new, as git detects renames. */
export const readRenames = ({
  baseRef,
  repoRoot,
}: ReadRenamesOptions): ReadonlyMap<string, string> => {
  const result = Bun.spawnSync(
    [
      "git",
      "diff",
      "--name-status",
      "--find-renames",
      "--diff-filter=R",
      "-z",
      baseRef,
    ],
    { cwd: repoRoot, stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    return panic(
      `git diff --find-renames ${baseRef} failed: ${result.stderr.toString()}`,
    );
  }
  // -z prints each rename as three NUL-terminated fields: status, old, new.
  const fields = result.stdout.toString().split("\0");
  const renames = new Map<string, string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const from = fields[index + 1];
    const to = fields[index + 2];
    if (from !== undefined && to !== undefined) {
      renames.set(from, to);
    }
  }
  return renames;
};

/** Re-keys each `path::rest` (or bare `path`) entry whose file has moved. */
export const renameEntries = (
  entries: readonly string[],
  renames: ReadonlyMap<string, string>,
): string[] =>
  entries.map((entry) => {
    const separator = entry.indexOf("::");
    const file = separator === -1 ? entry : entry.slice(0, separator);
    const moved = renames.get(file);
    return moved === undefined ? entry : `${moved}${entry.slice(file.length)}`;
  });
