import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type Expression,
  type Node,
  type ObjectExpression,
  parseSource,
  type Program,
  walk,
} from "../packages/scripts/src/syntax-tree";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SEED_PATHS = [
  "apps/api/scripts/seed-templates.ts",
  "apps/api/scripts/seed-dev.ts",
  "apps/api/scripts/seed-test-user.ts",
] as const;
const E2E_SPECS_GLOB = new Bun.Glob("apps/web/e2e/specs/**/*.spec.ts");

const readSourceFile = (relativePath: string) =>
  parseSource(
    relativePath,
    readFileSync(path.join(REPO_ROOT, relativePath), "utf-8"),
  ).program;

const propertyValue = (
  node: ObjectExpression,
  property: string,
): Expression | undefined => {
  for (const candidate of node.properties) {
    if (
      candidate.type === "Property" &&
      !candidate.computed &&
      !candidate.method &&
      candidate.kind === "init" &&
      !candidate.shorthand &&
      candidate.key.type === "Identifier" &&
      candidate.key.name === property
    ) {
      return candidate.value;
    }
  }
  return undefined;
};

const collectStringProperties = (
  node: Node,
  property: string,
  values: Set<string>,
): void => {
  walk(node, (child) => {
    if (
      child.type === "Property" &&
      !child.computed &&
      !child.method &&
      child.kind === "init" &&
      !child.shorthand &&
      child.key.type === "Identifier" &&
      child.key.name === property &&
      child.value.type === "Literal" &&
      typeof child.value.value === "string"
    ) {
      values.add(child.value.value);
    }
  });
};

const findVariableInitializer = (
  file: Program,
  name: string,
): Expression | undefined => {
  const initializers: Expression[] = [];
  walk(file, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === name &&
      node.init
    ) {
      initializers.push(node.init);
    }
  });
  return initializers.length === 1 ? initializers[0] : undefined;
};

const resolveStringValues = (
  expression: Node | undefined,
  file: Program,
  visited = new Set<string>(),
): Set<string> => {
  const values = new Set<string>();
  if (!expression) {
    return values;
  }
  if (expression.type === "Literal" && typeof expression.value === "string") {
    values.add(expression.value);
    return values;
  }
  if (expression.type === "Identifier" && !visited.has(expression.name)) {
    const nextVisited = new Set(visited).add(expression.name);
    return resolveStringValues(
      findVariableInitializer(file, expression.name),
      file,
      nextVisited,
    );
  }
  if (expression.type === "ArrayExpression") {
    for (const element of expression.elements) {
      const value =
        element?.type === "SpreadElement"
          ? element.argument
          : (element ?? undefined);
      for (const name of resolveStringValues(value, file, visited)) {
        values.add(name);
      }
    }
  }
  return values;
};

const resolveObject = (
  expression: Node | undefined,
  file: Program,
): ObjectExpression | undefined => {
  if (!expression) {
    return undefined;
  }
  if (expression.type === "ObjectExpression") {
    return expression;
  }
  if (expression.type === "Identifier") {
    return resolveObject(findVariableInitializer(file, expression.name), file);
  }
  return undefined;
};

const readSeededNames = (): Set<string> => {
  const templateNames = new Set<string>();
  const devDocumentNames = new Set<string>();
  const testUserNames = new Set<string>();

  const templateFile = readSourceFile(SEED_PATHS[0]);
  const templates = findVariableInitializer(templateFile, "TEMPLATES");
  if (templates?.type === "ArrayExpression") {
    for (const entry of templates.elements) {
      if (entry?.type !== "ObjectExpression") {
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
  if (workspaceDocs?.type === "ObjectExpression") {
    for (const workspace of workspaceDocs.properties) {
      if (
        workspace.type !== "Property" ||
        workspace.method ||
        workspace.kind !== "init" ||
        workspace.shorthand
      ) {
        continue;
      }
      for (const name of resolveStringValues(workspace.value, devFile)) {
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
  const file = parseSource("e2e.spec.ts", source).program;
  const names = new Set<string>();
  const readString = (expression: Expression | undefined): void => {
    for (const name of resolveStringValues(expression, file)) {
      names.add(name);
    }
  };
  walk(file, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      (node.callee.name === "apiUploadTemplate" ||
        node.callee.name === "apiUploadDocx")
    ) {
      const upload = resolveObject(
        node.callee.name === "apiUploadTemplate"
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
  });
  return names;
};

const findSeedNameReferences = (
  source: string,
  seedNames: ReadonlySet<string>,
): string[] => {
  const file = parseSource("e2e.spec.ts", source).program;
  const matches: string[] = [];
  walk(file, (node) => {
    let text: string | undefined;
    if (node.type === "Literal" && typeof node.value === "string") {
      text = node.value;
    } else if (node.type === "Literal" && "regex" in node) {
      // The literal as written, `/pattern/flags`, without escapes.
      text = `/${node.regex.pattern}/${node.regex.flags}`.replaceAll(
        /\\(.)/gu,
        "$1",
      );
    } else if (
      node.type === "TemplateLiteral" &&
      node.expressions.length === 0
    ) {
      text = node.quasis.at(0)?.value.cooked ?? undefined;
    }
    if (text !== undefined) {
      for (const name of seedNames) {
        if (text.includes(name)) {
          matches.push(name);
        }
      }
    }
  });
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
