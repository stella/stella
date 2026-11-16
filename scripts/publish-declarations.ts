import { panic } from "better-result";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

/** Declaration imports bind types independently of their emitted order. */
export const canonicalizeDeclarationImports = (source: string): string => {
  const parsed = ts.createSourceFile(
    "output.d.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const imports = parsed.statements.filter(ts.isImportDeclaration);
  const ordered = imports
    .map((statement) => statement.getText(parsed))
    .toSorted();
  let result = "";
  let offset = 0;
  for (const [index, statement] of imports.entries()) {
    result += source.slice(offset, statement.getStart(parsed));
    result += ordered.at(index) ?? panic("declaration import count changed");
    offset = statement.end;
  }
  return result + source.slice(offset);
};

export const canonicalizePublishedDeclarations = (directory: string): void => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      canonicalizePublishedDeclarations(filename);
      continue;
    }
    if (!entry.isFile() || !/\.d\.(?:ts|mts|cts)$/u.test(entry.name)) {
      continue;
    }
    const source = readFileSync(filename, "utf-8");
    const canonical = canonicalizeDeclarationImports(source);
    if (canonical !== source) {
      writeFileSync(filename, canonical);
    }
  }
};
