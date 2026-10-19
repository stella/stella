import { panic } from "better-result";
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CONSTRUCTOR_POLICIES = {
  createTtlResultCache: "readmit",
  createPublicStaticTtlResultCache: "public-static",
} as const;

const POLICIES = {
  "handlers/case-law/decisions/latest.ts": "readmit",
  "handlers/case-law/decisions/status.ts": "public-static",
  "handlers/legislation/facets.ts": "public-static",
  "handlers/legislation/shelf.ts": "public-static",
} as const;

test("shared cache callers declare their publication policy", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const seen: string[] = [];
  const files = new Bun.Glob("**/*.ts");
  for await (const file of files.scan({ cwd: root })) {
    if (
      file.endsWith(".test.ts") ||
      file === "lib/legal-search/browse-facets-cache.ts"
    ) {
      continue;
    }
    const text = await Bun.file(`${root}${file}`).text();
    if (!text.includes("browse-facets-cache")) {
      continue;
    }
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const constructors = new Map<string, string>();
    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier) ||
        !statement.moduleSpecifier.text.endsWith("/browse-facets-cache")
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        panic("Cache constructors use named imports");
      }
      for (const binding of bindings.elements) {
        const name = (binding.propertyName ?? binding.name).text;
        if (
          name === "createTtlResultCache" ||
          name === "createPublicStaticTtlResultCache"
        ) {
          constructors.set(binding.name.text, CONSTRUCTOR_POLICIES[name]);
        }
      }
    }
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        constructors.has(node.expression.text)
      ) {
        seen.push(file);
        const argument = node.arguments.at(0);
        if (!argument || !ts.isObjectLiteralExpression(argument)) {
          panic("Cache callers declare a literal publication policy");
        }
        const policy = argument.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(source) === "publication",
        );
        if (
          !policy ||
          !ts.isPropertyAssignment(policy) ||
          !ts.isObjectLiteralExpression(policy.initializer)
        ) {
          panic("Cache callers declare a publication policy");
        }
        const kind = policy.initializer.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText(source) === "kind",
        );
        if (
          !kind ||
          !ts.isPropertyAssignment(kind) ||
          !ts.isStringLiteral(kind.initializer)
        ) {
          panic("Cache publication policies declare their kind");
        }
        const expected = Object.entries(POLICIES)
          .find(([path]) => path === file)
          ?.at(1);
        expect(kind.initializer.text).toBe(expected);
        expect(constructors.get(node.expression.text)).toBe(expected);
        if (kind.initializer.text === "public-static") {
          const reason = policy.initializer.properties.find(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === "reason",
          );
          if (
            !reason ||
            !ts.isPropertyAssignment(reason) ||
            !ts.isStringLiteral(reason.initializer)
          ) {
            panic("Static publication policies declare their reason");
          }
          expect(reason.initializer.text.trim().length).toBeGreaterThan(0);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(seen.toSorted()).toEqual(Object.keys(POLICIES).toSorted());
});
