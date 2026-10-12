import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type TestFileGroup = { directory: string; files: string[] };

const hasTestScript = (directory: string) => {
  const manifest: unknown = JSON.parse(
    readFileSync(path.join(directory, "package.json"), "utf-8"),
  );
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    "scripts" in manifest &&
    typeof manifest.scripts === "object" &&
    manifest.scripts !== null &&
    "test" in manifest.scripts
  );
};

/**
 * The nearest workspace package that owns a test file, so its own test setup
 * (preloads, environment, runner) applies; root files run from the root.
 */
const owningDirectory = (root: string, file: string) => {
  let directory = path.dirname(file);
  while (directory !== "." && directory !== "") {
    if (
      existsSync(path.join(root, directory, "package.json")) &&
      hasTestScript(path.join(root, directory))
    ) {
      return directory;
    }
    directory = path.dirname(directory);
  }
  return ".";
};

export const groupTestFiles = (
  root: string,
  files: readonly string[],
): TestFileGroup[] => {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const directory = owningDirectory(root, file);
    // bun reads a bare argument as a path filter; ./ selects exactly this file.
    const relative = `./${directory === "." ? file : path.relative(directory, file)}`;
    const grouped = groups.get(directory) ?? [];
    grouped.push(relative);
    groups.set(directory, grouped);
  }
  return [...groups].map(([directory, grouped]) => ({
    directory,
    files: grouped,
  }));
};

if (import.meta.main) {
  const root = process.cwd();
  const files = (process.env["CHECK_TARGET"] ?? "").split(" ").filter(Boolean);
  let status = 0;
  for (const { directory, files: grouped } of groupTestFiles(root, files)) {
    const command =
      directory === "."
        ? ["bun", "test", ...grouped]
        : ["bun", "run", "test", ...grouped];
    const run = Bun.spawnSync(command, {
      cwd: path.join(root, directory),
      stdout: "inherit",
      stderr: "inherit",
    });
    status = Math.max(status, run.exitCode);
  }
  process.exit(status);
}
