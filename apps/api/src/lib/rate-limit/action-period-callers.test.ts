import { describe, expect, test } from "bun:test";
import ts from "typescript";

const srcRoot = new URL("../../", import.meta.url);
const propertyName = (name: ts.PropertyName) =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

describe("period identity coverage", () => {
  test("every current shared admission caller supplies a phase identity and finite declarations name their kind", async () => {
    const callers: string[] = [];
    const declarations: string[] = [];
    const authorizedFiniteCallers: string[] = [];
    for (const file of new Bun.Glob("**/*.ts").scanSync({
      cwd: srcRoot.pathname,
    })) {
      if (file.includes(".test.") || file.startsWith("tests/")) {
        continue;
      }
      const source = await Bun.file(new URL(file, srcRoot)).text();
      const tree = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
      );
      const admissionNames = new Set<string>();
      for (const statement of tree.statements) {
        if (!ts.isImportDeclaration(statement)) {
          continue;
        }
        const bindings = statement.importClause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) {
          continue;
        }
        for (const binding of bindings.elements) {
          if (
            (binding.propertyName ?? binding.name).text ===
            "withActionAdmission"
          ) {
            admissionNames.add(binding.name.text);
          }
        }
      }
      if (file === "lib/api-handlers.ts") {
        admissionNames.add("admit");
      }
      const discoverAdmissionDefaults = (node: ts.Node): void => {
        if (
          ts.isBindingElement(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isIdentifier(node.initializer) &&
          admissionNames.has(node.initializer.text)
        ) {
          admissionNames.add(node.name.text);
        }
        ts.forEachChild(node, discoverAdmissionDefaults);
      };
      discoverAdmissionDefaults(tree);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          admissionNames.has(node.expression.text)
        ) {
          callers.push(file);
          const options = node.arguments.at(0);
          expect(options && ts.isObjectLiteralExpression(options), file).toBe(
            true,
          );
          if (options && ts.isObjectLiteralExpression(options)) {
            expect(
              options.properties.some(
                (property) =>
                  ts.isPropertyAssignment(property) &&
                  propertyName(property.name) === "periodIdentity",
              ),
              file,
            ).toBe(true);
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === "admitFiniteAction"
        ) {
          authorizedFiniteCallers.push(file);
          const options = node.arguments.at(0);
          expect(options && ts.isObjectLiteralExpression(options), file).toBe(
            true,
          );
          if (options && ts.isObjectLiteralExpression(options)) {
            expect(
              options.properties.some(
                (property) =>
                  ts.isPropertyAssignment(property) &&
                  propertyName(property.name) === "actionKind" &&
                  ts.isStringLiteral(property.initializer) &&
                  property.initializer.text.length > 0,
              ),
              file,
            ).toBe(true);
          }
        }
        if (
          ts.isPropertyAssignment(node) &&
          propertyName(node.name) === "actionAdmission"
        ) {
          declarations.push(file);
          expect(ts.isObjectLiteralExpression(node.initializer), file).toBe(
            true,
          );
          if (ts.isObjectLiteralExpression(node.initializer)) {
            expect(
              node.initializer.properties.some(
                (property) =>
                  ts.isPropertyAssignment(property) &&
                  propertyName(property.name) === "actionKind" &&
                  ts.isStringLiteral(property.initializer) &&
                  property.initializer.text.length > 0,
              ),
              file,
            ).toBe(true);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(callers.toSorted()).toEqual([
      "lib/api-handlers.ts",
      "mcp/server-core.ts",
    ]);
    expect(declarations.toSorted()).toEqual([
      "handlers/chat/improve-prompt.ts",
    ]);
    expect(authorizedFiniteCallers).toEqual([
      "handlers/chat/suggest-thread-title.ts",
    ]);
  });
});
