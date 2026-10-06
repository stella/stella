import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "../../..");
const rootScripts = path.join(root, "scripts");

const moduleSpecifiers = (source: string) => {
  const tree = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const argument = node.arguments.at(0);
      if (
        argument &&
        (ts.isStringLiteral(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument))
      ) {
        specifiers.push(argument.text);
      } else {
        specifiers.push("<computed module specifier>");
      }
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifiers.push(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return specifiers;
};

const rootScriptImports = (file: string, source: string) =>
  moduleSpecifiers(source).filter((specifier) => {
    if (specifier === "<computed module specifier>") {
      return true;
    }
    const destination = path.resolve(
      path.dirname(path.join(root, file)),
      specifier,
    );
    return (
      destination === rootScripts ||
      destination.startsWith(`${rootScripts}${path.sep}`)
    );
  });

test("packaged script sources never import repository-root scripts", () => {
  for (const file of new Bun.Glob(
    "packages/scripts/src/**/*.{ts,tsx,mts,cts,js,mjs,cjs}",
  ).scanSync({ cwd: root })) {
    if (file.endsWith(".test.ts")) {
      continue;
    }
    expect(
      rootScriptImports(file, readFileSync(path.join(root, file), "utf-8")),
      file,
    ).toEqual([]);
  }
});

test("generated output inventory has no module dependencies", () => {
  expect(
    moduleSpecifiers(
      readFileSync(new URL("generated-files.ts", import.meta.url), "utf-8"),
    ),
  ).toEqual([]);
});

for (const mutation of [
  'import { CI_GENERATED_FILES } from "../../../scripts/generated-files";',
  'export { CI_GENERATED_FILES } from "../../../scripts/generated-files";',
  'const inventory = import("../../../scripts/generated-files");',
  'const inventory = require("../../../scripts/generated-files");',
  'type Inventory = import("../../../scripts/generated-files");',
]) {
  test(`package boundary rejects root-script mutation: ${mutation}`, () => {
    const file = "packages/scripts/src/prepared-generated-sources.ts";
    const source = readFileSync(path.join(root, file), "utf-8");
    expect(rootScriptImports(file, source)).toEqual([]);
    expect(rootScriptImports(file, `${source}\n${mutation}`)).toEqual([
      "../../../scripts/generated-files",
    ]);
  });
}

for (const mutation of [
  'const target = "../../../scripts/generated-files"; import(target);',
  'const target = "../../../scripts/generated-files"; require(target);',
]) {
  test(`package boundary rejects unresolved module mutation: ${mutation}`, () => {
    expect(moduleSpecifiers(mutation)).toEqual(["<computed module specifier>"]);
    expect(
      rootScriptImports("packages/scripts/src/generated-files.ts", mutation),
    ).toEqual(["<computed module specifier>"]);
  });
}
