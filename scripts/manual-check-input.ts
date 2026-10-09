import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const MANUAL_CHECKS = [
  "typecheck-repo",
  "typecheck-package",
  "lint",
  "test-files",
  "verify-affected",
] as const;
export type ManualCheck = (typeof MANUAL_CHECKS)[number];

const packageNames = (root: string) =>
  ["apps", "packages"].flatMap((directory) =>
    readdirSync(path.join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, directory, entry.name, "package.json"))
      .filter(existsSync)
      .map((file) => JSON.parse(readFileSync(file, "utf-8")).name)
      .filter((name): name is string => typeof name === "string"),
  );

const safeTestPath = /^[A-Za-z0-9._/-]+\.test\.tsx?$/u;
const shellMetacharacters = /[;&|`$(){}<>*?!'"\\[\]\n\r]/u;

export const validateManualCheckInput = (
  check: string,
  target: string,
  root = path.resolve(import.meta.dirname, ".."),
): string[] => {
  if (!MANUAL_CHECKS.some((candidate) => candidate === check)) {
    return [`unknown check: ${check}`];
  }
  if (check === "typecheck-package") {
    if (!/^@stll\/[a-z0-9-]+$/u.test(target)) {
      return ["target must be an @stll/<name> workspace package"];
    }
    return packageNames(root).includes(target)
      ? []
      : [`unknown workspace package: ${target}`];
  }
  if (check === "test-files") {
    // Split exactly as the workflow's `IFS=' ' read -r -a` does: a newline or
    // tab stays inside a token and fails the path check, so no listed file
    // can be validated here yet skipped at execution.
    const files = target.split(" ").filter(Boolean);
    if (files.length === 0) {
      return ["target must list at least one test file"];
    }
    if (files.length > 50) {
      return ["target may list at most 50 test files"];
    }
    for (const file of files) {
      if (
        file.startsWith("/") ||
        file.split("/").includes("..") ||
        shellMetacharacters.test(file) ||
        !safeTestPath.test(file)
      ) {
        return [`invalid test file path: ${file}`];
      }
      if (!existsSync(path.join(root, file))) {
        return [`missing test file: ${file}`];
      }
    }
    return [];
  }
  return target === "" ? [] : [`target must be empty for ${check}`];
};

if (import.meta.main) {
  const errors = validateManualCheckInput(
    process.env["CHECK_CHECK"] ?? "",
    process.env["CHECK_TARGET"] ?? "",
  );
  for (const error of errors) {
    console.error(`::error::${error}`);
  }
  process.exit(errors.length === 0 ? 0 : 1);
}
