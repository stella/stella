import { panic } from "better-result";
import path from "node:path";

import { parseSource } from "@stll/scripts/src/syntax-tree";

import {
  deriveCapabilityId,
  deriveHandlerImportPath,
} from "./capability-catalog";

const exportedNames = (source: string) => {
  const { program } = parseSource("handler.ts", source);
  const names = new Set<string | undefined>();
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      names.add(undefined);
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") {
      continue;
    }
    // oxc marks `export type { … }` and also `export declare const …` as type
    // exports; only the former exports no value.
    for (const element of statement.specifiers) {
      if (statement.exportKind !== "type" && element.exportKind !== "type") {
        const name =
          element.exported.type === "Literal"
            ? element.exported.value
            : element.exported.name;
        names.add(name === "default" ? undefined : name);
      }
    }
    const { declaration } = statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type === "Identifier") {
          names.add(declarator.id.name);
        }
      }
      continue;
    }
    if (
      (declaration?.type === "FunctionDeclaration" ||
        declaration?.type === "TSDeclareFunction" ||
        declaration?.type === "ClassDeclaration") &&
      declaration.id
    ) {
      names.add(declaration.id.name);
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
