import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import * as ts from "typescript6";

import { repoRelativePath } from "@stll/portable-path";

const SCRIPT_EXTENSION = /\.[cm]?[jt]sx?$/u;
const CANDIDATE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
];

const collectStaticImports = (file: string, text: string) => {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  const imports: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword) {
        continue;
      }
      const bindings = clause?.namedBindings;
      if (
        clause?.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly)
      ) {
        continue;
      }
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        imports.push(statement.moduleSpecifier.text);
      }
      continue;
    }
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const clause = statement.exportClause;
    if (
      clause !== undefined &&
      ts.isNamedExports(clause) &&
      clause.elements.length > 0 &&
      clause.elements.every((element) => element.isTypeOnly)
    ) {
      continue;
    }
    imports.push(statement.moduleSpecifier.text);
  }
  return imports;
};

type WalkEagerGraphOptions = {
  root: string;
  entry: string;
  forbidden: readonly string[];
  readSource?: (file: string) => string;
  isFile?: (file: string) => boolean;
};

export const walkEagerGraph = ({
  root,
  entry,
  forbidden,
  readSource = (file) => readFileSync(file, "utf-8"),
  isFile = (file) => existsSync(file) && statSync(file).isFile(),
}: WalkEagerGraphOptions) => {
  const resolveImport = (specifier: string, from: string) => {
    if (!specifier.startsWith("@/") && !specifier.startsWith(".")) {
      return undefined;
    }
    const base = specifier.startsWith("@/")
      ? nodePath.resolve(root, specifier.slice(2))
      : nodePath.resolve(nodePath.dirname(from), specifier);
    return CANDIDATE_SUFFIXES.map((suffix) => base + suffix).find(
      (candidate) => SCRIPT_EXTENSION.test(candidate) && isFile(candidate),
    );
  };
  const entryFile = nodePath.resolve(root, entry);
  const forbiddenFiles = new Set(
    forbidden.map((specifier) => {
      const file = resolveImport(specifier, entryFile);
      assert.ok(file, `Cannot resolve forbidden module ${specifier}`);
      return file;
    }),
  );
  const visited = new Set<string>();
  const violations: string[] = [];
  const stack = [{ file: entryFile, chain: [entry] }];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || visited.has(next.file)) {
      continue;
    }
    visited.add(next.file);
    for (const specifier of collectStaticImports(
      next.file,
      readSource(next.file),
    )) {
      const file = resolveImport(specifier, next.file);
      if (file === undefined) {
        continue;
      }
      const chain = [...next.chain, repoRelativePath(root, file)];
      if (forbiddenFiles.has(file)) {
        violations.push(chain.join(" -> "));
        continue;
      }
      stack.push({ file, chain });
    }
  }
  return { visited, violations };
};
