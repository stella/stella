import { readFileSync } from "node:fs";
import path from "node:path";

import { type ParsedSource, parseSource } from "./syntax-tree";

type SourceFileEntry = {
  filePath: string;
  relativePath: string;
  sourceText: string;
  sourceFile: () => ParsedSource;
};

const indexes = new Map<string, readonly SourceFileEntry[]>();

type SourceFileIndexOptions = {
  pattern?: string;
};

export const containsJsxTag = (sourceText: string) => sourceText.includes("<");

/** A process-wide, read-once index of the sources below one root. */
export const sourceFileIndex = (
  sourceRoot: string,
  { pattern = "**/*.{ts,tsx}" }: SourceFileIndexOptions = {},
) => {
  const root = path.resolve(sourceRoot);
  const cacheKey = `${root}\0${pattern}`;
  const cached = indexes.get(cacheKey);
  if (cached) {
    return cached;
  }

  const entries = [
    ...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true }),
  ]
    .toSorted()
    .map((relativePath) => {
      const filePath = path.join(root, relativePath);
      const sourceText = readFileSync(filePath, "utf-8");
      let parsed: ParsedSource | undefined;
      return {
        filePath,
        relativePath,
        sourceText,
        sourceFile: () => {
          parsed ??= parseSource(filePath, sourceText);
          return parsed;
        },
      };
    });
  indexes.set(cacheKey, entries);
  return entries;
};
