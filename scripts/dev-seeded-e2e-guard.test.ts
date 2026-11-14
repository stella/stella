import { panic } from "better-result";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import {
  type Expression,
  type Node,
  type ObjectExpression,
  parseSource,
  type Program,
  staticPropertyName,
  walk,
} from "../packages/scripts/src/syntax-tree";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TEST_USER_SEED_PATH = "apps/api/scripts/seed-test-user.ts";
const E2E_SPECS_GLOB = new Bun.Glob("apps/web/e2e/specs/**/*.spec.ts");

type SeedSourceFile = {
  program: Program;
  fileName: string;
};

const readSourceFile = (relativePath: string): SeedSourceFile => ({
  program: parseSource(
    relativePath,
    readFileSync(path.join(REPO_ROOT, relativePath), "utf-8"),
  ).program,
  fileName: relativePath,
});

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
  file: SeedSourceFile,
  name: string,
): Expression | undefined => {
  const initializers: Expression[] = [];
  walk(file.program, (node) => {
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

type SeedSourceExpression = {
  expression: Expression;
  file: SeedSourceFile;
  visited: ReadonlySet<string>;
};
type ResolveSeedSourceOptions = {
  expression: Expression | undefined;
  file: SeedSourceFile;
  visited?: ReadonlySet<string>;
  files: Map<string, SeedSourceFile>;
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
    expression.type === "TSAsExpression" ||
    expression.type === "TSSatisfiesExpression" ||
    expression.type === "ParenthesizedExpression"
  ) {
    return resolveSeedSource({
      expression: expression.expression,
      file,
      visited,
      files,
    });
  }
  if (expression.type === "Identifier") {
    const name = expression.name;
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
    for (const statement of file.program.body) {
      if (statement.type !== "ImportDeclaration") {
        continue;
      }
      const binding = statement.specifiers.find(
        (specifier) =>
          specifier.type === "ImportSpecifier" && specifier.local.name === name,
      );
      if (!binding || binding.type !== "ImportSpecifier") {
        continue;
      }
      const specifier = statement.source.value;
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
          binding.imported.type === "Identifier"
            ? binding.imported.name
            : binding.imported.value,
        ),
        file: imported,
        visited: nextVisited,
        files,
      });
    }
    return [];
  }
  if (expression.type === "MemberExpression") {
    let property: string | undefined;
    if (!expression.computed && expression.property.type === "Identifier") {
      property = expression.property.name;
    } else if (
      expression.property.type === "Literal" &&
      typeof expression.property.value === "string"
    ) {
      property = expression.property.value;
    }
    return resolveSeedSource({
      expression: expression.object,
      file,
      visited,
      files,
    }).flatMap((source) => {
      if (source.expression.type !== "ObjectExpression") {
        return [];
      }
      return source.expression.properties.flatMap((candidate) => {
        if (
          candidate.type !== "Property" ||
          candidate.method ||
          candidate.kind !== "init" ||
          candidate.shorthand
        ) {
          return [];
        }
        const key = staticPropertyName(candidate);
        if (property !== undefined && key !== property) {
          return [];
        }
        return resolveSeedSource({
          expression: candidate.value,
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
    if (
      source.expression.type === "Literal" &&
      typeof source.expression.value === "string"
    ) {
      values.add(source.expression.value);
      continue;
    }
    const children: Expression[] = [];
    if (source.expression.type === "ArrayExpression") {
      for (const element of source.expression.elements) {
        if (element) {
          children.push(
            element.type === "SpreadElement" ? element.argument : element,
          );
        }
      }
    } else if (source.expression.type === "ObjectExpression") {
      for (const property of source.expression.properties) {
        if (property.type === "SpreadElement") {
          children.push(property.argument);
        } else if (
          !property.method &&
          property.kind === "init" &&
          !property.shorthand
        ) {
          children.push(property.value);
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
  expression: Node | undefined,
  file: SeedSourceFile,
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
  file: SeedSourceFile,
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

  const files = new Map<string, SeedSourceFile>();
  const localeFile = readSourceFile("apps/api/scripts/seed-content/locales.ts");
  const locales = findVariableInitializer(localeFile, "SEED_CONTENT_BY_LOCALE");
  const packs = resolveSeedSource({
    expression: locales,
    file: localeFile,
    files,
  });
  for (const packMap of packs) {
    if (packMap.expression.type !== "ObjectExpression") {
      continue;
    }
    for (const locale of packMap.expression.properties) {
      if (
        locale.type !== "Property" ||
        locale.method ||
        locale.kind !== "init" ||
        locale.shorthand
      ) {
        continue;
      }
      for (const pack of resolveSeedSource({
        expression: locale.value,
        file: packMap.file,
        files,
      })) {
        if (pack.expression.type !== "ObjectExpression") {
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
          if (templates.expression.type !== "ObjectExpression") {
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
  collectStringProperties(testUserFile.program, "name", testUserNames);
  collectStringProperties(testUserFile.program, "fileName", testUserNames);

  const names = new Set([...templateNames, ...devDocumentNames]);
  for (const testUserName of testUserNames) {
    names.delete(testUserName);
  }
  return names;
};

const collectUploadedNames = (source: string): Set<string> => {
  const file = {
    program: parseSource("e2e.spec.ts", source).program,
    fileName: "e2e.spec.ts",
  };
  const names = new Set<string>();
  const readString = (expression: Expression | undefined): void => {
    for (const name of resolveStringValues(expression, file)) {
      names.add(name);
    }
  };
  walk(file.program, (node) => {
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
  const file = {
    program: parseSource("e2e.spec.ts", source).program,
    fileName: "e2e.spec.ts",
  };
  const matches: string[] = [];
  walk(file.program, (node) => {
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
