import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { canonicalModuleId } from "../../../../.oxlint-plugins/module-id.ts";
import { VERIFICATION_MODEL_ROLE } from "../../src/lib/lists/verification/model-call";
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

const resolveCheckerExport = (
  moduleId: string,
  exportedName: string,
  visited = new Set<string>(),
): ConditionalOperation["checker"] | undefined => {
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
  const absoluteModuleFile = path.join(REPO_ROOT, moduleFile);
  if (!existsSync(absoluteModuleFile)) {
    return undefined;
  }
  const source = ts.createSourceFile(
    moduleFile,
    readFileSync(absoluteModuleFile, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
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
      return resolveCheckerExport(
        canonicalModuleId(statement.moduleSpecifier.text, moduleFile),
        element.propertyName?.text ?? element.name.text,
        visited,
      );
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
  if (ts.isIdentifier(node) && node.text === "VERIFICATION_MODEL_ROLE") {
    return VERIFICATION_MODEL_ROLE;
  }
  return panic(`Admission census cannot resolve ${node.getText()}`);
};

type EnumerateConditionalOperationsOptions = { file: string; text: string };

export const enumerateConditionalOperations = ({
  file,
  text,
}: EnumerateConditionalOperationsOptions): ConditionalOperation[] => {
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
        const checker = resolveCheckerExport(
          moduleId,
          imported.propertyName?.text ?? imported.name.text,
        );
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
        checker = resolveCheckerExport(
          namespaces.get(expression.expression.text) ??
            panic("Missing namespace"),
          expression.name.text,
        );
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
  for await (const file of new Bun.Glob("apps/api/src/**/*.ts").scan({
    cwd: REPO_ROOT,
  })) {
    if (file.includes("/tests/") || file.endsWith(".test.ts")) {
      continue;
    }
    const text = await Bun.file(path.join(REPO_ROOT, file)).text();
    operations.push(...enumerateConditionalOperations({ file, text }));
  }
  return operations;
};
