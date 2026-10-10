import { describe, expect, test } from "bun:test";
import path from "node:path";
import ts from "typescript";

const apiRoot = path.resolve(import.meta.dir, "../../..");
const guardedSymbols = new Map([
  ["s3", new Set(["writeS3ObjectWithRetry"])],
  ["file-scan/stored-object", new Set(["writeScannedObject"])],
]);

// Types require ownership at every direct and forwarded call. Keep one import
// spelling so dynamic loading and relative aliases cannot conceal the owner.
const importViolations = (file: string, source: string) => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];
  const moduleOwner = (specifier: string) => {
    const resolved = specifier.startsWith(".")
      ? path.posix.normalize(
          path.posix.join(path.posix.dirname(file), specifier),
        )
      : specifier.replace("@/api/", "src/");
    for (const [module, symbols] of guardedSymbols) {
      if (resolved.replace(/\.(?:ts|js)$/u, "") === `src/lib/${module}`) {
        return { canonical: `@/api/lib/${module}`, symbols };
      }
    }
    return undefined;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = node.arguments.at(0);
      if (specifier && ts.isStringLiteral(specifier)) {
        const owner = moduleOwner(specifier.text);
        if (owner) {
          for (const symbol of owner.symbols) {
            if (!source.includes(symbol)) {
              continue;
            }
            violations.push(`${file}:${symbol}: dynamic import`);
          }
        }
      }
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const owner = moduleOwner(node.moduleSpecifier.text);
      if (owner) {
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : node.exportClause;
        const importedSymbols = (() => {
          if (bindings && ts.isNamedImports(bindings)) {
            return bindings.elements.map(
              (item) => item.propertyName?.text ?? item.name.text,
            );
          }
          if (bindings && ts.isNamedExports(bindings)) {
            return bindings.elements.map(
              (item) => item.propertyName?.text ?? item.name.text,
            );
          }
          return [...owner.symbols];
        })();
        for (const symbol of importedSymbols) {
          if (!owner.symbols.has(symbol)) {
            continue;
          }
          if (ts.isExportDeclaration(node)) {
            violations.push(`${file}:${symbol}: re-export`);
          } else if (node.moduleSpecifier.text !== owner.canonical) {
            violations.push(`${file}:${symbol}: relative import`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return violations;
};

describe("object write ownership imports", () => {
  test.each([
    [
      'import { writeS3ObjectWithRetry as put } from "../lib/s3";',
      "relative import",
    ],
    ['import * as storage from "../lib/s3";', "relative import"],
    [
      'const storage = await import("../lib/s3"); storage.writeS3ObjectWithRetry({ key, data });',
      "dynamic import",
    ],
    [
      'const { writeS3ObjectWithRetry } = await import("@/api/lib/s3");',
      "dynamic import",
    ],
    [
      'export { writeS3ObjectWithRetry as put } from "@/api/lib/s3";',
      "re-export",
    ],
  ])("detects concealed owner in %s", (source, violation) => {
    expect(importViolations("src/handlers/example.ts", source)).toEqual([
      `src/handlers/example.ts:writeS3ObjectWithRetry: ${violation}`,
    ]);
  });

  test("allows canonical aliases and unrelated relative imports", () => {
    expect(
      importViolations(
        "src/handlers/example.ts",
        'import { writeS3ObjectWithRetry as put } from "@/api/lib/s3"; import { getS3 } from "../lib/s3";',
      ),
    ).toEqual([]);
  });

  test("production callers use canonical static symbols", async () => {
    const files = [
      ...new Bun.Glob("{src,scripts}/**/*.ts").scanSync({ cwd: apiRoot }),
    ].filter(
      (file) => !file.endsWith(".test.ts") && !file.endsWith(".spec.ts"),
    );
    const violations: string[] = [];
    for (const file of files) {
      const source = await Bun.file(path.join(apiRoot, file)).text();
      if (!source.includes("s3") && !source.includes("stored-object")) {
        continue;
      }
      violations.push(...importViolations(file, source));
    }
    expect(violations).toEqual([]);
  });
});
