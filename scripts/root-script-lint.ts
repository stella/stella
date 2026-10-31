import { isChangedLintPath } from "./lint-paths";

export const isRootScriptLintPath = (file: string): boolean =>
  file.startsWith("scripts/") &&
  file.endsWith(".ts") &&
  isChangedLintPath(file);

export const rootScriptLintPaths = (files: readonly string[]): string[] =>
  [...new Set(files.filter(isRootScriptLintPath))].toSorted();

export const rootTypeAwareLintCommand = (
  files: readonly string[],
): string[] => [
  "bun",
  "--bun",
  "oxlint",
  "-c",
  "oxlint.config.ts",
  "--report-unused-disable-directives-severity=error",
  "--type-aware",
  "--type-check",
  ...files,
];
