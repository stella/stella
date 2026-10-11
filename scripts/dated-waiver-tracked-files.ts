import { panic } from "better-result";
import path from "node:path";

export const trackedPolicyFiles = (): string[] => {
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: path.resolve(import.meta.dir, ".."),
  });
  if (proc.exitCode !== 0) {
    panic("Cannot enumerate tracked policy files");
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
};
