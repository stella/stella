import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

type SourceFileEntry = {
  filePath: string;
  relativePath: string;
  sourceText: string;
  sourceFile: (setParentNodes?: boolean) => ts.SourceFile;
};

const indexes = new Map<string, readonly SourceFileEntry[]>();

export const containsJsxTag = (sourceText: string) => sourceText.includes("<");

/** A process-wide, read-once index of the TypeScript sources below one root. */
export const sourceFileIndex = (sourceRoot: string) => {
  const root = path.resolve(sourceRoot);
  const cached = indexes.get(root);
  if (cached) {
    return cached;
  }

  const entries = [
    ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root, onlyFiles: true }),
  ]
    .toSorted()
    .map((relativePath) => {
      const filePath = path.join(root, relativePath);
      const sourceText = readFileSync(filePath, "utf-8");
      let parsedWithParents: ts.SourceFile | undefined;
      let parsedWithoutParents: ts.SourceFile | undefined;
      return {
        filePath,
        relativePath,
        sourceText,
        sourceFile: (setParentNodes = true) => {
          const cachedSource = setParentNodes
            ? parsedWithParents
            : parsedWithoutParents;
          if (cachedSource) {
            return cachedSource;
          }
          const source = ts.createSourceFile(
            filePath,
            sourceText,
            ts.ScriptTarget.Latest,
            setParentNodes,
            filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
          );
          if (setParentNodes) {
            parsedWithParents = source;
          } else {
            parsedWithoutParents = source;
          }
          return source;
        },
      };
    });
  indexes.set(root, entries);
  return entries;
};
