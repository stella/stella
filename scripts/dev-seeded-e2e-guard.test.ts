import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SEED_PATHS = [
  "apps/api/scripts/seed-templates.ts",
  "apps/api/scripts/seed-dev.ts",
  "apps/api/scripts/seed-test-user.ts",
] as const;
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

  const templateFile = readSourceFile(SEED_PATHS[0]);
  const templates = findVariableInitializer(templateFile, "TEMPLATES");
  if (templates && ts.isArrayLiteralExpression(templates)) {
    for (const entry of templates.elements) {
      if (!ts.isObjectLiteralExpression(entry)) {
        continue;
      }
      for (const property of ["name", "fileName"]) {
        for (const name of resolveStringValues(
          propertyValue(entry, property),
          templateFile,
        )) {
          templateNames.add(name);
        }
      }
    }
  }

  const devFile = readSourceFile(SEED_PATHS[1]);
  const workspaceDocs = findVariableInitializer(devFile, "workspaceDocNames");
  if (workspaceDocs && ts.isObjectLiteralExpression(workspaceDocs)) {
    for (const workspace of workspaceDocs.properties) {
      if (!ts.isPropertyAssignment(workspace)) {
        continue;
      }
      for (const name of resolveStringValues(workspace.initializer, devFile)) {
        devDocumentNames.add(name);
      }
    }
  }
  expect(templateNames.size).toBeGreaterThan(0);
  expect(devDocumentNames.size).toBeGreaterThan(0);

  const testUserFile = readSourceFile(SEED_PATHS[2]);
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
