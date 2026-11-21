import { lintCommand } from "./lint-command";
import { isChangedLintPath } from "./lint-paths";

export const isRootScriptLintPath = (file: string): boolean =>
  file.startsWith("scripts/") &&
  file.endsWith(".ts") &&
  isChangedLintPath(file);

export const rootScriptLintPaths = (files: readonly string[]): string[] =>
  [...new Set(files.filter(isRootScriptLintPath))].toSorted();

export const rootTypeAwareLintCommand = (files: readonly string[]): string[] =>
  lintCommand({}, files);
