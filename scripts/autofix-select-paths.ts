import { lstatSync, readFileSync, writeFileSync } from "node:fs";

import { isAutofixProtectedPath } from "./autofix-protected-paths";

const readNullSeparatedPaths = (file: string) =>
  readFileSync(file, "utf-8").split("\0").filter(Boolean);

const isRegularFile = (file: string) => {
  try {
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

export const selectAutofixPaths = (paths: readonly string[]) => {
  const format: string[] = [];
  const lint: string[] = [];
  for (const file of paths) {
    if (
      !isRegularFile(file) ||
      file.startsWith(".github/workflows/") ||
      isAutofixProtectedPath(file)
    ) {
      continue;
    }
    const selected = `./${file}`;
    format.push(selected);
    if (
      /\.([cm]?[jt]s|[jt]sx)$/u.test(file) &&
      !file.startsWith("apps/landing/")
    ) {
      lint.push(selected);
    }
  }
  return { format, lint };
};

const writeNullSeparatedPaths = (file: string, paths: readonly string[]) =>
  writeFileSync(file, paths.length === 0 ? "" : `${paths.join("\0")}\0`);

if (import.meta.main) {
  const [input, formatOutput, lintOutput] = process.argv.slice(2);
  if (!input || !formatOutput || !lintOutput) {
    process.stderr.write(
      "Usage: autofix-select-paths <input> <format-output> <lint-output>\n",
    );
    process.exitCode = 2;
  } else {
    const selected = selectAutofixPaths(readNullSeparatedPaths(input));
    writeNullSeparatedPaths(formatOutput, selected.format);
    writeNullSeparatedPaths(lintOutput, selected.lint);
  }
}
