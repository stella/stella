import { panic } from "better-result";
import path from "node:path";
import ts from "typescript6";

import {
  deriveCapabilityId,
  deriveHandlerImportPath,
} from "./capability-catalog";

const exportedNames = (source: string) => {
  const tree = ts.createSourceFile(
    "handler.ts",
    source,
    ts.ScriptTarget.Latest,
    false,
  );
  const names = new Set<string | undefined>();
  for (const statement of tree.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      names.add(undefined);
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          names.add(
            element.name.text === "default" ? undefined : element.name.text,
          );
        }
      }
      continue;
    }
    if (!ts.canHaveModifiers(statement)) {
      continue;
    }
    const modifiers = ts.getModifiers(statement);
    if (!modifiers?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword)) {
      continue;
    }
    if (modifiers.some(({ kind }) => kind === ts.SyntaxKind.DefaultKeyword)) {
      names.add(undefined);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
      continue;
    }
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    }
  }
  return names;
};

type CapabilityHandler = { importPath: string; exportName: string | undefined };

// Read exports without importing the handler graph, which consumes this runtime.
export const buildCapabilityHandlerIndex = async (
  root: string,
  ids: readonly string[],
) => {
  const required = new Set(ids);
  const moduleIds = new Set([
    ...ids,
    ...ids.map((id) => id.slice(0, id.lastIndexOf("."))),
  ]);
  const handlers = new Map<string, CapabilityHandler>();
  for (const file of new Bun.Glob("apps/api/src/handlers/**/*.ts").scanSync({
    cwd: root,
    onlyFiles: true,
  })) {
    if (file.endsWith(".test.ts")) {
      continue;
    }
    if (!moduleIds.has(deriveCapabilityId({ file, exportName: undefined }))) {
      continue;
    }
    const source = await Bun.file(path.join(root, file)).text();
    for (const exportName of exportedNames(source)) {
      const id = deriveCapabilityId({ file, exportName });
      if (!required.has(id)) {
        continue;
      }
      if (handlers.has(id)) {
        panic(`Capability ${id} has multiple handler sources`);
      }
      handlers.set(id, {
        importPath: deriveHandlerImportPath(file),
        exportName,
      });
    }
  }
  for (const id of required) {
    if (!handlers.has(id)) {
      panic(
        `Capability ${id} has no handler source export; regenerate the capability catalog`,
      );
    }
  }
  return handlers;
};
