/**
 * The retention projections stay independent of the code they check, through
 * every helper they import, not only at the import the lint rule sees.
 *
 * `retention-source-independence` rejects a projection module's own import of
 * parser code; a helper module one hop away is outside its scope, so a helper
 * reaching a parser, an adapter or the AST package would let the projection
 * read the source through the parser after all. This walks the value import
 * graph the parser-version guard walks, from every module under
 * `retention/sources/`, and fails on any reachable module in those trees.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { type SourceTree, valueImportGraph } from "./check-parser-versions.ts";

const REPOSITORY_ROOT = path.resolve(import.meta.dir, "..");
const SOURCES_DIRECTORY =
  "apps/api/src/handlers/case-law/ingestion/retention/sources/";

/** Code a projection may not reach, as the lint rule names it. */
const PARSER_OR_AST_ROOTS = [
  "apps/api/src/handlers/case-law/ingestion/parsers/",
  "apps/api/src/handlers/case-law/ingestion/adapters/",
  "apps/api/src/lib/legal-search/parsers/",
  "packages/legal-ast/",
] as const;

/**
 * Files listed up front and read on first use: the walk reaches a few
 * hundred of the repository's thousands of modules.
 */
class LazyFiles extends Map<string, string> {
  override get(file: string): string | undefined {
    const cached = super.get(file);
    if (cached !== "" || !this.has(file)) {
      return cached;
    }
    const source = readFileSync(path.join(REPOSITORY_ROOT, file), "utf-8");
    this.set(file, source);
    return source;
  }
}

/**
 * The working tree as the guard reads a git tree: tracked and untracked
 * files under the roots it resolves.
 */
const workingTree = (): SourceTree => {
  const listed = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "apps/api/src",
      "packages",
    ],
    { cwd: REPOSITORY_ROOT, stdout: "pipe", stderr: "pipe" },
  );
  if (listed.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  }
  const files = new LazyFiles();
  for (const file of listed.stdout.toString().split("\n")) {
    // A file the listing names but the tree no longer holds (deleted and
    // not yet staged) is not a module anything can import.
    if (
      (/\.[cm]?[jt]sx?$/u.test(file) || file.endsWith("/package.json")) &&
      existsSync(path.join(REPOSITORY_ROOT, file))
    ) {
      files.set(file, "");
    }
  }
  return files;
};

/** The import chain from `from` to `to`, for a message that says how. */
const chainTo = (
  graph: ReturnType<typeof valueImportGraph>,
  from: string,
  to: string,
): string[] => {
  const parents = new Map<string, string>();
  const queue = [from];
  const seen = new Set(queue);
  for (
    let current = queue.shift();
    current !== undefined;
    current = queue.shift()
  ) {
    if (current === to) {
      const chain = [to];
      for (let at = parents.get(to); at !== undefined; at = parents.get(at)) {
        chain.unshift(at);
      }
      return chain;
    }
    for (const next of graph.imports(current)) {
      if (!seen.has(next)) {
        seen.add(next);
        parents.set(next, current);
        queue.push(next);
      }
    }
  }
  return [from, to];
};

/** Every forbidden module each projection module reaches, with its chain. */
const violations = (files: SourceTree, modules: readonly string[]) => {
  const graph = valueImportGraph(files);
  return modules.flatMap((module) =>
    [...graph.closure(module)]
      .filter((reached) =>
        PARSER_OR_AST_ROOTS.some((root) => reached.startsWith(root)),
      )
      .map((reached) => chainTo(graph, module, reached).join(" -> ")),
  );
};

describe("retention projections reach no parser or AST code", () => {
  test("no module under retention/sources reaches one, through any helper", () => {
    const files = workingTree();
    const modules = [...files.keys()].filter(
      (file) =>
        file.startsWith(SOURCES_DIRECTORY) &&
        file.endsWith(".ts") &&
        !file.endsWith(".test.ts"),
    );
    expect(modules.length).toBeGreaterThan(20);
    expect(violations(files, modules)).toEqual([]);
  });

  test("a helper one hop away that reaches a parser is reported", () => {
    const files: SourceTree = new Map([
      [
        `${SOURCES_DIRECTORY}planted.ts`,
        'import { helper } from "@/api/lib/planted-helper";\nimport type { Block } from "@stll/legal-ast/document-ast";\nexport const read = (b: Block) => helper(b);',
      ],
      [
        "apps/api/src/lib/planted-helper.ts",
        'import { readRtf } from "./legal-search/parsers/rtf-reader";\nexport const helper = (value: unknown) => readRtf(value);',
      ],
      [
        "apps/api/src/lib/legal-search/parsers/rtf-reader.ts",
        "export const readRtf = (value: unknown) => value;",
      ],
    ]);
    expect(violations(files, [`${SOURCES_DIRECTORY}planted.ts`])).toEqual([
      `${SOURCES_DIRECTORY}planted.ts -> apps/api/src/lib/planted-helper.ts -> apps/api/src/lib/legal-search/parsers/rtf-reader.ts`,
    ]);
  });

  test("a type-only import of parser or AST code is not a dependency", () => {
    const files: SourceTree = new Map([
      [
        `${SOURCES_DIRECTORY}typed.ts`,
        'import type { Raw } from "@/api/handlers/case-law/ingestion/adapters/raw";\nexport const read = (raw: Raw) => raw;',
      ],
      [
        "apps/api/src/handlers/case-law/ingestion/adapters/raw.ts",
        "export type Raw = string;",
      ],
    ]);
    expect(violations(files, [`${SOURCES_DIRECTORY}typed.ts`])).toEqual([]);
  });
});
