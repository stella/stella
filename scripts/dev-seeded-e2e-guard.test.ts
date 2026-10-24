import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript6";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TEST_USER_SEED_PATH = "apps/api/scripts/seed-test-user.ts";
const E2E_SPECS_GLOB = new Bun.Glob("apps/web/e2e/specs/**/*.spec.ts");

const readSourceFile = (relativePath: string): ts.SourceFile =>
  ts.createSourceFile(
    relativePath,
    readFileSync(path.join(REPO_ROOT, relativePath), "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );

const propertyValue = (
  node: ts.ObjectLiteralExpression,
  property: string,
): ts.Expression | undefined =>
  node.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === property,
  )?.initializer;

const collectStringProperties = (
  node: ts.Node,
  property: string,
  values: Set<string>,
): void => {
  if (
    ts.isPropertyAssignment(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === property &&
    ts.isStringLiteral(node.initializer)
  ) {
    values.add(node.initializer.text);
  }
  ts.forEachChild(node, (child) =>
    collectStringProperties(child, property, values),
  );
};

const findVariableInitializer = (
  file: ts.SourceFile,
  name: string,
): ts.Expression | undefined => {
  const initializers: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      initializers.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return initializers.length === 1 ? initializers[0] : undefined;
};

type SeedSourceExpression = {
  expression: ts.Expression;
  file: ts.SourceFile;
  visited: ReadonlySet<string>;
};
type ResolveSeedSourceOptions = {
  expression: ts.Expression | undefined;
  file: ts.SourceFile;
  visited?: ReadonlySet<string>;
  files: Map<string, ts.SourceFile>;
};

const resolveSeedSource = ({
  expression,
  file,
  visited = new Set(),
  files,
}: ResolveSeedSourceOptions): SeedSourceExpression[] => {
  if (!expression) {
    return [];
  }
  if (
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isParenthesizedExpression(expression)
  ) {
    return resolveSeedSource({
      expression: expression.expression,
      file,
      visited,
      files,
    });
  }
  if (ts.isIdentifier(expression)) {
    const name = expression.text;
    const identity = `${file.fileName}:${name}`;
    if (visited.has(identity)) {
      return [];
    }
    const nextVisited = new Set(visited).add(identity);
    const local = findVariableInitializer(file, name);
    if (local) {
      return resolveSeedSource({
        expression: local,
        file,
        visited: nextVisited,
        files,
      });
    }
    for (const statement of file.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        continue;
      }
      const binding = bindings.elements.find(
        (element) => element.name.text === name,
      );
      if (!binding) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".") && !specifier.startsWith("@stll/")) {
        return [];
      }
      const resolved = Bun.resolveSync(
        specifier,
        path.dirname(path.join(REPO_ROOT, file.fileName)),
      );
      if (!isPathInside(REPO_ROOT, resolved)) {
        panic(`Seed source must remain in the repository: ${specifier}`);
      }
      const relative = repoRelativePath(REPO_ROOT, resolved);
      let imported = files.get(relative);
      if (!imported) {
        imported = readSourceFile(relative);
        files.set(relative, imported);
      }
      return resolveSeedSource({
        expression: findVariableInitializer(
          imported,
          binding.propertyName?.text ?? binding.name.text,
        ),
        file: imported,
        visited: nextVisited,
        files,
      });
    }
    return [];
  }
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    let property: string | undefined;
    if (ts.isPropertyAccessExpression(expression)) {
      property = expression.name.text;
    } else if (ts.isStringLiteral(expression.argumentExpression)) {
      property = expression.argumentExpression.text;
    }
    return resolveSeedSource({
      expression: expression.expression,
      file,
      visited,
      files,
    }).flatMap((source) => {
      if (!ts.isObjectLiteralExpression(source.expression)) {
        return [];
      }
      return source.expression.properties.flatMap((candidate) => {
        if (!ts.isPropertyAssignment(candidate)) {
          return [];
        }
        const key =
          ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)
            ? candidate.name.text
            : undefined;
        if (property !== undefined && key !== property) {
          return [];
        }
        return resolveSeedSource({
          expression: candidate.initializer,
          file: source.file,
          visited: source.visited,
          files,
        });
      });
    });
  }
  return [{ expression, file, visited }];
};

const collectSeedStrings = ({
  expression,
  file,
  visited = new Set(),
  files,
}: ResolveSeedSourceOptions): Set<string> => {
  const values = new Set<string>();
  for (const source of resolveSeedSource({
    expression,
    file,
    visited,
    files,
  })) {
    if (ts.isStringLiteral(source.expression)) {
      values.add(source.expression.text);
      continue;
    }
    const children: ts.Expression[] = [];
    if (ts.isArrayLiteralExpression(source.expression)) {
      for (const element of source.expression.elements) {
        children.push(
          ts.isSpreadElement(element) ? element.expression : element,
        );
      }
    } else if (ts.isObjectLiteralExpression(source.expression)) {
      for (const property of source.expression.properties) {
        if (ts.isPropertyAssignment(property)) {
          children.push(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          children.push(property.expression);
        }
      }
    }
    for (const child of children) {
      for (const value of collectSeedStrings({
        expression: child,
        file: source.file,
        visited: source.visited,
        files,
      })) {
        values.add(value);
      }
    }
  }
  return values;
};

const resolveStringValues = (
  expression: ts.Expression | undefined,
  file: ts.SourceFile,
  visited = new Set<string>(),
): Set<string> => {
  const values = new Set<string>();
  if (!expression) {
    return values;
  }
  if (ts.isStringLiteral(expression)) {
    values.add(expression.text);
    return values;
  }
  if (ts.isIdentifier(expression) && !visited.has(expression.text)) {
    const nextVisited = new Set(visited).add(expression.text);
    return resolveStringValues(
      findVariableInitializer(file, expression.text),
      file,
      nextVisited,
    );
  }
  if (ts.isArrayLiteralExpression(expression)) {
    for (const element of expression.elements) {
      const value = ts.isSpreadElement(element) ? element.expression : element;
      for (const name of resolveStringValues(value, file, visited)) {
        values.add(name);
      }
    }
  }
  return values;
};

const resolveObject = (
  expression: ts.Expression | undefined,
  file: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined => {
  if (!expression) {
    return undefined;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  if (ts.isIdentifier(expression)) {
    return resolveObject(findVariableInitializer(file, expression.text), file);
  }
  return undefined;
};

const readSeededNames = (): Set<string> => {
  const templateNames = new Set<string>();
  const devDocumentNames = new Set<string>();
  const testUserNames = new Set<string>();

  const files = new Map<string, ts.SourceFile>();
  const localeFile = readSourceFile("apps/api/scripts/seed-content/locales.ts");
  const locales = findVariableInitializer(localeFile, "SEED_CONTENT_BY_LOCALE");
  const packs = resolveSeedSource({
    expression: locales,
    file: localeFile,
    files,
  });
  for (const packMap of packs) {
    if (!ts.isObjectLiteralExpression(packMap.expression)) {
      continue;
    }
    for (const locale of packMap.expression.properties) {
      if (!ts.isPropertyAssignment(locale)) {
        continue;
      }
      for (const pack of resolveSeedSource({
        expression: locale.initializer,
        file: packMap.file,
        files,
      })) {
        if (!ts.isObjectLiteralExpression(pack.expression)) {
          continue;
        }
        for (const name of collectSeedStrings({
          expression: propertyValue(pack.expression, "matterDocuments"),
          file: pack.file,
          files,
        })) {
          devDocumentNames.add(name);
        }
        for (const templates of resolveSeedSource({
          expression: propertyValue(pack.expression, "templates"),
          file: pack.file,
          files,
        })) {
          if (!ts.isObjectLiteralExpression(templates.expression)) {
            continue;
          }
          const names = propertyValue(templates.expression, "templates");
          for (const value of collectSeedStrings({
            expression: names,
            file: templates.file,
            files,
          })) {
            templateNames.add(value);
          }
        }
      }
    }
  }
  expect(templateNames.size).toBeGreaterThan(0);
  expect(devDocumentNames.size).toBeGreaterThan(0);

  const testUserFile = readSourceFile(TEST_USER_SEED_PATH);
  collectStringProperties(testUserFile, "name", testUserNames);
  collectStringProperties(testUserFile, "fileName", testUserNames);

  const names = new Set([...templateNames, ...devDocumentNames]);
  for (const testUserName of testUserNames) {
    names.delete(testUserName);
  }
  return names;
};

const collectUploadedNames = (source: string): Set<string> => {
  const file = ts.createSourceFile(
    "e2e.spec.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();
  const readString = (expression: ts.Expression | undefined): void => {
    for (const name of resolveStringValues(expression, file)) {
      names.add(name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      (node.expression.text === "apiUploadTemplate" ||
        node.expression.text === "apiUploadDocx")
    ) {
      const upload = resolveObject(
        node.expression.text === "apiUploadTemplate"
          ? node.arguments[1]
          : node.arguments[3],
        file,
      );
      if (upload) {
        readString(propertyValue(upload, "name"));
        const uploadedFile = resolveObject(propertyValue(upload, "file"), file);
        if (uploadedFile) {
          readString(propertyValue(uploadedFile, "name"));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
};

const findSeedNameReferences = (
  source: string,
  seedNames: ReadonlySet<string>,
): string[] => {
  const file = ts.createSourceFile(
    "e2e.spec.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const matches: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node)) {
      const text = ts.isRegularExpressionLiteral(node)
        ? node.text.replaceAll(/\\(.)/gu, "$1")
        : node.text;
      for (const name of seedNames) {
        if (text.includes(name)) {
          matches.push(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...new Set(matches)].toSorted();
};

test("web e2e specs do not depend on dev-seeded template or document names", () => {
  const seedNames = readSeededNames();
  expect(seedNames.size).toBeGreaterThan(0);

  const violations: string[] = [];
  for (const relativePath of E2E_SPECS_GLOB.scanSync(REPO_ROOT)) {
    const source = readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
    const uploads = collectUploadedNames(source);
    for (const name of findSeedNameReferences(source, seedNames)) {
      if (!uploads.has(name)) {
        violations.push(`${relativePath}: ${name}`);
      }
    }
  }
  expect(violations).toEqual([]);
});

test("the detector finds every derived seed name in string and regex literals", () => {
  const seedNames = readSeededNames();
  expect(seedNames.size).toBeGreaterThan(0);

  for (const name of seedNames) {
    expect(
      findSeedNameReferences(JSON.stringify(name), new Set([name])),
    ).toContain(name);
    const regexLiteral = `/${name.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/u`;
    expect(findSeedNameReferences(regexLiteral, new Set([name]))).toContain(
      name,
    );
  }
});

test("uploaded names are exempt only in the spec that uploads them", () => {
  const seedNames = readSeededNames();
  const uploadedSpec = `
    const upload = { name: "Supplier_Agreement.docx" };
    apiUploadDocx(request, workspaceId, propertyId, upload);
    page.getByText("Supplier_Agreement.docx");
  `;
  const otherSpec = 'page.getByText("Supplier_Agreement.docx");';

  expect(seedNames.has("Supplier_Agreement.docx")).toBe(true);
  expect(collectUploadedNames(uploadedSpec)).toContain(
    "Supplier_Agreement.docx",
  );
  expect(
    findSeedNameReferences(uploadedSpec, seedNames).filter(
      (name) => !collectUploadedNames(uploadedSpec).has(name),
    ),
  ).toEqual([]);
  expect(
    findSeedNameReferences(otherSpec, seedNames).filter(
      (name) => !collectUploadedNames(otherSpec).has(name),
    ),
  ).toContain("Supplier_Agreement.docx");
});
