import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

import { isPlaywrightTestFile } from "./e2e-spec-shards-core";

const CONFIG_PATH = "apps/web/e2e/playwright.config.ts";

const createConfigReader = (tree: ts.SourceFile) => {
  const bindings = new Map<string, ts.Expression>();
  const configFactories = new Set<string>();
  let exported: ts.Expression | undefined;
  for (const statement of tree.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      exported = statement.expression;
    }
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags === ts.NodeFlags.Const
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          bindings.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@playwright/test"
    ) {
      const imports = statement.importClause?.namedBindings;
      if (imports && ts.isNamedImports(imports)) {
        for (const imported of imports.elements) {
          if (
            (imported.propertyName ?? imported.name).text === "defineConfig"
          ) {
            configFactories.add(imported.name.text);
          }
        }
      }
    }
  }
  const resolve = (
    expression: ts.Expression | undefined,
    seen = new Set<string>(),
  ): ts.Expression | undefined => {
    if (!expression) {
      return undefined;
    }
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression)
    ) {
      return resolve(expression.expression, seen);
    }
    if (!ts.isIdentifier(expression)) {
      return expression;
    }
    if (seen.has(expression.text)) {
      return undefined;
    }
    seen.add(expression.text);
    return resolve(bindings.get(expression.text), seen);
  };
  const properties = (expression: ts.Expression | undefined) => {
    const resolved = resolve(expression);
    if (!resolved || !ts.isObjectLiteralExpression(resolved)) {
      return undefined;
    }
    const fields = new Map<string, ts.Expression>();
    for (const property of resolved.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        fields.set(property.name.text, property.name);
        continue;
      }
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ) {
        return undefined;
      }
      fields.set(property.name.text, property.initializer);
    }
    return fields;
  };
  let configExpression = resolve(exported);
  if (configExpression && ts.isCallExpression(configExpression)) {
    if (
      !ts.isIdentifier(configExpression.expression) ||
      !configFactories.has(configExpression.expression.text) ||
      configExpression.arguments.length !== 1
    ) {
      return undefined;
    }
    configExpression = configExpression.arguments.at(0);
  }
  const config = properties(configExpression);
  if (!config) {
    return undefined;
  }
  const strings = (expression: ts.Expression): string[] | undefined => {
    const resolved = resolve(expression);
    if (!resolved) {
      return undefined;
    }
    if (ts.isStringLiteralLike(resolved)) {
      return [resolved.text];
    }
    if (!ts.isArrayLiteralExpression(resolved)) {
      return undefined;
    }
    const values: string[] = [];
    for (const element of resolved.elements) {
      const value = resolve(element);
      if (!value || !ts.isStringLiteralLike(value)) {
        return undefined;
      }
      values.push(value.text);
    }
    return values;
  };
  const matchers = (
    expression: ts.Expression,
  ): ((file: string) => boolean)[] | undefined => {
    const resolved = resolve(expression);
    if (!resolved) {
      return undefined;
    }
    if (ts.isStringLiteralLike(resolved)) {
      // Playwright prepends **/ and matches string patterns without case.
      // Extglobs require minimatch semantics; widen rather than approximate.
      if (/[@+?!*]\(/u.test(resolved.text)) {
        return undefined;
      }
      const pattern = resolved.text.startsWith("**/")
        ? resolved.text
        : `**/${resolved.text}`;
      const glob = new Bun.Glob(pattern.toLowerCase());
      return [(file) => glob.match(file.toLowerCase())];
    }
    if (ts.isRegularExpressionLiteral(resolved)) {
      const text = resolved.text;
      const end = text.lastIndexOf("/");
      const pattern = new RegExp(text.slice(1, end), text.slice(end + 1));
      return [
        (file) => {
          pattern.lastIndex = 0;
          return pattern.test(file);
        },
      ];
    }
    if (!ts.isArrayLiteralExpression(resolved)) {
      return undefined;
    }
    const predicates: ((file: string) => boolean)[] = [];
    for (const element of resolved.elements) {
      const parsed = matchers(element);
      if (!parsed) {
        return undefined;
      }
      predicates.push(...parsed);
    }
    return predicates;
  };
  return { config, resolve, properties, strings, matchers };
};

type SetupProjectInputsOptions = NonNullable<
  ReturnType<typeof createConfigReader>
> & {
  root: string;
  directory: string;
};

const setupProjectInputs = ({
  root,
  directory,
  config,
  resolve,
  properties,
  strings,
  matchers,
}: SetupProjectInputsOptions): string[] | undefined => {
  const entries: string[] = [];
  const projectsExpression = config.get("projects");
  if (!projectsExpression) {
    return [];
  }
  const projects = resolve(projectsExpression);
  if (!projects || !ts.isArrayLiteralExpression(projects)) {
    return undefined;
  }
  const namedProjects = new Map<string, Map<string, ts.Expression>>();
  const setupNames = new Set<string>();
  for (const project of projects.elements) {
    const fields = properties(project);
    if (!fields) {
      return undefined;
    }
    const name = resolve(fields.get("name"));
    if (!name || !ts.isStringLiteralLike(name)) {
      return undefined;
    }
    if (namedProjects.has(name.text)) {
      return undefined;
    }
    namedProjects.set(name.text, fields);
    for (const field of ["dependencies", "teardown"]) {
      const value = fields.get(field);
      if (!value) {
        continue;
      }
      const names = strings(value);
      if (!names) {
        return undefined;
      }
      for (const setupName of names) {
        setupNames.add(setupName);
      }
    }
  }
  for (const setupName of setupNames) {
    const project = namedProjects.get(setupName);
    if (!project) {
      return undefined;
    }
    const testDirExpression = project.get("testDir") ?? config.get("testDir");
    const testDir = testDirExpression ? resolve(testDirExpression) : undefined;
    if (testDirExpression && (!testDir || !ts.isStringLiteralLike(testDir))) {
      return undefined;
    }
    const testDirectory = path.resolve(
      directory,
      testDir && ts.isStringLiteralLike(testDir) ? testDir.text : ".",
    );
    const relativeDirectory = path.relative(root, realpathSync(testDirectory));
    if (
      relativeDirectory.startsWith("../") ||
      path.isAbsolute(relativeDirectory)
    ) {
      return undefined;
    }
    const testMatch = project.get("testMatch") ?? config.get("testMatch");
    const predicates = testMatch ? matchers(testMatch) : [isPlaywrightTestFile];
    if (!predicates) {
      return undefined;
    }
    for (const file of readdirSync(testDirectory, {
      recursive: true,
      encoding: "utf-8",
    })) {
      const absolute = path.join(testDirectory, file);
      if (
        lstatSync(absolute).isFile() &&
        predicates.some((matches) => matches(absolute))
      ) {
        entries.push(path.relative(root, absolute));
      }
    }
  }
  return entries;
};

// Resolve only static configuration, without executing code from a pull request.
// Unknown configuration is handled by the caller's full-suite fallback.
export const e2eRunnerInputs = (root: string): string[] | undefined => {
  const absoluteConfig = path.join(root, CONFIG_PATH);
  const source = readFileSync(absoluteConfig, "utf-8");
  new Bun.Transpiler({ loader: "ts" }).scan(source);
  const tree = ts.createSourceFile(
    absoluteConfig,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const reader = createConfigReader(tree);
  if (!reader) {
    return undefined;
  }
  const { config, strings } = reader;
  const directory = path.dirname(absoluteConfig);
  const entries = [CONFIG_PATH];
  for (const hook of ["globalSetup", "globalTeardown"]) {
    const value = config.get(hook);
    if (!value) {
      continue;
    }
    const references = strings(value);
    if (!references) {
      return undefined;
    }
    for (const reference of references) {
      const absolute = realpathSync(Bun.resolveSync(reference, directory));
      const relative = path.relative(root, absolute);
      if (relative.startsWith("../") || relative.includes("node_modules/")) {
        return undefined;
      }
      entries.push(relative);
    }
  }
  const setupInputs = setupProjectInputs({ root, directory, ...reader });
  return setupInputs === undefined ? undefined : [...entries, ...setupInputs];
};
