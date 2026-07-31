import { expect, test } from "@playwright/test";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

const E2E_ROOT = path.resolve(import.meta.dirname, "..");
const READINESS_LIFECYCLES = new Set(["commit", "domcontentloaded"]);
// Every `page.*` call that starts a navigation, mapped to the argument index
// carrying its options: `goto` takes (url, options); reload and the history
// navigations take (options) alone. History navigations count because they
// default to the `load` lifecycle exactly like `goto` does.
const NAVIGATION_OPTIONS_INDEX = new Map([
  ["goBack", 0],
  ["goForward", 0],
  ["goto", 1],
  ["reload", 0],
]);

test("route navigation waits for an explicit lifecycle before UI readiness", async () => {
  const violations = (
    await Promise.all((await specFiles(E2E_ROOT)).map(navigationViolations))
  ).flat();

  expect(violations).toEqual([]);
});

const specFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          return await specFiles(entryPath);
        }
        if (
          entry.name.endsWith(".spec.ts") ||
          entry.name.endsWith(".spec.tsx")
        ) {
          return [entryPath];
        }
        return [];
      }),
    )
  ).flat();
};

const navigationViolations = async (filePath: string): Promise<string[]> => {
  const sourceText = await readFile(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  const violations: string[] = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isPageNavigation(node)) {
      const lifecycle = navigationLifecycle(node);
      if (!READINESS_LIFECYCLES.has(lifecycle ?? "")) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        violations.push(
          `${path.relative(E2E_ROOT, filePath)}:${line + 1} uses ${
            node.expression.name.text
          } without waitUntil: "commit" or "domcontentloaded"`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return violations;
};

type PageNavigationCall = ts.CallExpression & {
  expression: ts.PropertyAccessExpression & {
    expression: ts.Identifier;
  };
};

const isPageNavigation = (
  call: ts.CallExpression,
): call is PageNavigationCall =>
  ts.isPropertyAccessExpression(call.expression) &&
  ts.isIdentifier(call.expression.expression) &&
  call.expression.expression.text === "page" &&
  NAVIGATION_OPTIONS_INDEX.has(call.expression.name.text);

const navigationLifecycle = (call: PageNavigationCall): string | null => {
  const options = call.arguments.at(
    NAVIGATION_OPTIONS_INDEX.get(call.expression.name.text) ?? 0,
  );
  if (!options || !ts.isObjectLiteralExpression(options)) {
    return null;
  }
  const waitUntil = options.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText() === "waitUntil",
  );
  if (!waitUntil || !ts.isPropertyAssignment(waitUntil)) {
    return null;
  }
  return ts.isStringLiteral(waitUntil.initializer)
    ? waitUntil.initializer.text
    : null;
};
