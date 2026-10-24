import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { canonicalModuleId } from "../../../../.oxlint-plugins/module-id.ts";
import { VERIFICATION_MODEL_TASK } from "../../src/lib/lists/verification/model-call";
import { REPO_ROOT } from "./enumerate-safe-handlers";

type ConditionalOperation = {
  file: string;
  line: number;
  checker: "authorizeHandlerUsage" | "authorizeHandlerRunSize";
  metering: unknown;
};

const checkerName = (value: string) => {
  switch (value) {
    case "authorizeHandlerUsage":
    case "authorizeHandlerRunSize":
      return value;
    default:
      return undefined;
  }
};

const CHECKER_MODULE = "apps/api/src/lib/api-handlers";

type ResolveCheckerExportOptions = {
  moduleId: string;
  exportedName: string;
  sources: Map<string, ts.SourceFile | undefined>;
  visited?: Set<string>;
};

const resolveCheckerExport = ({
  moduleId,
  exportedName,
  sources,
  visited = new Set<string>(),
}: ResolveCheckerExportOptions):
  ConditionalOperation["checker"] | undefined => {
  const checker = checkerName(exportedName);
  if (moduleId === CHECKER_MODULE) {
    return checker;
  }
  const visitKey = `${moduleId}:${exportedName}`;
  if (visited.has(visitKey)) {
    return undefined;
  }
  visited.add(visitKey);
  const moduleFile = `${moduleId}.ts`;
  if (!sources.has(moduleFile)) {
    const absoluteModuleFile = path.join(REPO_ROOT, moduleFile);
    sources.set(
      moduleFile,
      existsSync(absoluteModuleFile)
        ? ts.createSourceFile(
            moduleFile,
            readFileSync(absoluteModuleFile, "utf-8"),
            ts.ScriptTarget.Latest,
            true,
          )
        : undefined,
    );
  }
  const source = sources.get(moduleFile);
  if (source === undefined) {
    return undefined;
  }
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== exportedName) {
        continue;
      }
      return resolveCheckerExport({
        moduleId: canonicalModuleId(statement.moduleSpecifier.text, moduleFile),
        exportedName: element.propertyName?.text ?? element.name.text,
        sources,
        visited,
      });
    }
  }
  return undefined;
};

const readMeteringValue = (node: ts.Expression): unknown => {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }
  if (ts.isConditionalExpression(node)) {
    return readMeteringValue(node.whenTrue);
  }
  if (ts.isObjectLiteralExpression(node)) {
    return Object.fromEntries(
      node.properties.map((property) => {
        if (!ts.isPropertyAssignment(property)) {
          panic("Admission census requires explicit metering fields");
        }
        return [
          property.name.getText(),
          readMeteringValue(property.initializer),
        ];
      }),
    );
  }
  if (ts.isIdentifier(node) && node.text === "VERIFICATION_MODEL_TASK") {
    return VERIFICATION_MODEL_TASK;
  }
  return panic(`Admission census cannot resolve ${node.getText()}`);
};

type EnumerateConditionalOperationsOptions = { file: string; text: string };

export const enumerateConditionalOperations = ({
  file,
  text,
}: EnumerateConditionalOperationsOptions): ConditionalOperation[] =>
  enumerateWithSources({ file, text, sources: new Map() });

type EnumerateWithSourcesOptions = EnumerateConditionalOperationsOptions & {
  sources: Map<string, ts.SourceFile | undefined>;
};

const enumerateWithSources = ({
  file,
  text,
  sources,
}: EnumerateWithSourcesOptions): ConditionalOperation[] => {
  const operations: ConditionalOperation[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const aliases = new Map<string, ConditionalOperation["checker"]>();
  const namespaces = new Map<string, string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleId = canonicalModuleId(statement.moduleSpecifier.text, file);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      namespaces.set(bindings.name.text, moduleId);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const imported of bindings.elements) {
        const checker = resolveCheckerExport({
          moduleId,
          exportedName: imported.propertyName?.text ?? imported.name.text,
          sources,
        });
        if (checker) {
          aliases.set(imported.name.text, checker);
        }
      }
    }
  }
  // Handler factories retain the real checker as an injectable default.
  const discoverDefaults = (node: ts.Node) => {
    if (
      ts.isBindingElement(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.initializer)
    ) {
      const checker = aliases.get(node.initializer.text);
      if (checker !== undefined) {
        aliases.set(node.name.text, checker);
      }
    }
    ts.forEachChild(node, discoverDefaults);
  };
  discoverDefaults(source);
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      let checker: ConditionalOperation["checker"] | undefined;
      if (ts.isIdentifier(expression)) {
        checker = aliases.get(expression.text);
      } else if (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        namespaces.has(expression.expression.text)
      ) {
        checker = resolveCheckerExport({
          moduleId:
            namespaces.get(expression.expression.text) ??
            panic("Missing namespace"),
          exportedName: expression.name.text,
          sources,
        });
      }
      if (checker) {
        const input = node.arguments.at(0);
        if (!input || !ts.isObjectLiteralExpression(input)) {
          panic(`Admission census requires an explicit input at ${file}`);
        }
        const metering = input.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText() === "metering",
        );
        if (!metering || !ts.isPropertyAssignment(metering)) {
          panic(`Admission census lacks metering at ${file}`);
        }
        operations.push({
          file,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
          checker,
          metering: readMeteringValue(metering.initializer),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return operations;
};

export const discoverConditionalOperations = async (): Promise<
  ConditionalOperation[]
> => {
  const operations: ConditionalOperation[] = [];
  // Imported modules recur across symbols and owners. Cache only their parsed
  // syntax for this census; resolution and operation collection still run anew.
  const sources = new Map<string, ts.SourceFile | undefined>();
  for await (const file of new Bun.Glob("apps/api/src/**/*.ts").scan({
    cwd: REPO_ROOT,
  })) {
    if (file.includes("/tests/") || file.endsWith(".test.ts")) {
      continue;
    }
    const text = await Bun.file(path.join(REPO_ROOT, file)).text();
    operations.push(...enumerateWithSources({ file, text, sources }));
  }
  return operations;
};
