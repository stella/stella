import { panic } from "better-result";
import path from "node:path";
import ts from "typescript";

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
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const aliases = new Map<string, ConditionalOperation["checker"]>();
    const namespaces = new Set<string>();
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "@/api/lib/api-handlers"
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        namespaces.add(bindings.name.text);
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const imported of bindings.elements) {
          const checker = checkerName(
            imported.propertyName?.text ?? imported.name.text,
          );
          if (checker) {
            aliases.set(imported.name.text, checker);
          }
        }
      }
    }
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
          checker = checkerName(expression.name.text);
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
  }
  return operations;
};
