import path from "node:path";

// Runs before any dependency install (install-free-ci.test.ts), so it
// raises a tagged built-in error instead of a better-result panic.
export class TrackedPolicyFilesError extends Error {
  override name = "TrackedPolicyFilesError";
  readonly _tag = "TrackedPolicyFilesError";
}

export const trackedPolicyFiles = (): string[] => {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: path.resolve(import.meta.dir, ".."),
  });
  if (proc.exitCode !== 0) {
    throw new TrackedPolicyFilesError("Cannot enumerate tracked policy files");
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
};
