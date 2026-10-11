import { readFileSync, realpathSync } from "node:fs";
import nodePath from "node:path";

type StaticImportGraphOptions = {
  entries: readonly string[];
  shouldTraverse: (file: string) => boolean;
  readFile?: (file: string) => string;
  onImport?: (dependency: {
    importer: string;
    specifier: string;
    resolved: string | null;
  }) => void;
};

const transpiler = new Bun.Transpiler({ loader: "ts" });

/** Walk static imports resolved with Bun's workspace-aware module resolver. */
export const walkStaticImportGraph = ({
  entries,
  shouldTraverse,
  readFile = (file) => readFileSync(file, "utf-8"),
  onImport,
}: StaticImportGraphOptions): string[] => {
  const pending = entries.map((entry) => realpathSync(entry));
  const visited = new Set<string>();

  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || visited.has(file) || !shouldTraverse(file)) {
      continue;
    }
    visited.add(file);

    for (const dependency of transpiler.scanImports(readFile(file))) {
      const resolved =
        dependency.path.endsWith(".md") || dependency.path.startsWith("node:")
          ? null
          : realpathSync(
              Bun.resolveSync(dependency.path, nodePath.dirname(file)),
            );
      onImport?.({ importer: file, specifier: dependency.path, resolved });
      if (resolved !== null && shouldTraverse(resolved)) {
        pending.push(resolved);
      }
    }
  }

  return [...visited].toSorted();
};
