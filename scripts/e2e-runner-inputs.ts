import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { repoRelativePath } from "@stll/portable-path";

import {
  type Node,
  parseSource,
  type Program,
} from "../packages/scripts/src/syntax-tree";
import { isPlaywrightTestFile } from "./e2e-spec-shards-core";

const stringValue = (node: Node): string | undefined => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

const CONFIG_PATH = "apps/web/e2e/playwright.config.ts";

const createConfigReader = (tree: Program) => {
  const bindings = new Map<string, Node>();
  const configFactories = new Set<string>();
  let exported: Node | undefined;
  for (const entry of tree.body) {
    const statement =
      entry.type === "ExportNamedDeclaration" && entry.declaration
        ? entry.declaration
        : entry;
    if (statement.type === "ExportDefaultDeclaration") {
      exported = statement.declaration;
    }
    if (
      statement.type === "VariableDeclaration" &&
      statement.kind === "const"
    ) {
      for (const declaration of statement.declarations) {
        if (declaration.id.type === "Identifier" && declaration.init) {
          bindings.set(declaration.id.name, declaration.init);
        }
      }
    }
    if (
      statement.type === "ImportDeclaration" &&
      statement.source.value === "@playwright/test"
    ) {
      for (const imported of statement.specifiers) {
        if (
          imported.type === "ImportSpecifier" &&
          (imported.imported.type === "Identifier"
            ? imported.imported.name
            : imported.imported.value) === "defineConfig"
        ) {
          configFactories.add(imported.local.name);
        }
      }
    }
  }
  const resolve = (
    expression: Node | null | undefined,
    seen = new Set<string>(),
  ): Node | undefined => {
    if (!expression) {
      return undefined;
    }
    if (
      expression.type === "ParenthesizedExpression" ||
      expression.type === "TSAsExpression" ||
      expression.type === "TSSatisfiesExpression"
    ) {
      return resolve(expression.expression, seen);
    }
    if (expression.type !== "Identifier") {
      return expression;
    }
    if (seen.has(expression.name)) {
      return undefined;
    }
    seen.add(expression.name);
    return resolve(bindings.get(expression.name), seen);
  };
  const properties = (expression: Node | null | undefined) => {
    const resolved = resolve(expression);
    if (!resolved || resolved.type !== "ObjectExpression") {
      return undefined;
    }
    const fields = new Map<string, Node>();
    for (const property of resolved.properties) {
      if (
        property.type !== "Property" ||
        property.computed ||
        property.method ||
        property.kind !== "init" ||
        !(
          property.key.type === "Identifier" ||
          (property.key.type === "Literal" &&
            typeof property.key.value === "string")
        )
      ) {
        return undefined;
      }
      fields.set(
        property.key.type === "Identifier"
          ? property.key.name
          : property.key.value,
        property.value,
      );
    }
    return fields;
  };
  let configExpression = resolve(exported);
  if (configExpression?.type === "CallExpression") {
    if (
      configExpression.callee.type !== "Identifier" ||
      !configFactories.has(configExpression.callee.name) ||
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
  const strings = (expression: Node): string[] | undefined => {
    const resolved = resolve(expression);
    if (!resolved) {
      return undefined;
    }
    const literal = stringValue(resolved);
    if (literal !== undefined) {
      return [literal];
    }
    if (resolved.type !== "ArrayExpression") {
      return undefined;
    }
    const values: string[] = [];
    for (const element of resolved.elements) {
      const value = resolve(element);
      const elementValue = value ? stringValue(value) : undefined;
      if (elementValue === undefined) {
        return undefined;
      }
      values.push(elementValue);
    }
    return values;
  };
  const matchers = (
    expression: Node,
  ): ((file: string) => boolean)[] | undefined => {
    const resolved = resolve(expression);
    if (!resolved) {
      return undefined;
    }
    const literal = stringValue(resolved);
    if (literal !== undefined) {
      // Playwright prepends **/ and matches string patterns without case.
      // Extglobs require minimatch semantics; widen rather than approximate.
      if (/[@+?!*]\(/u.test(literal)) {
        return undefined;
      }
      const pattern = literal.startsWith("**/") ? literal : `**/${literal}`;
      const glob = new Bun.Glob(pattern.toLowerCase());
      return [(file) => glob.match(file.toLowerCase())];
    }
    if (resolved.type === "Literal" && "regex" in resolved) {
      const text = resolved.raw;
      const end = text.lastIndexOf("/");
      const pattern = new RegExp(text.slice(1, end), text.slice(end + 1));
      return [
        (file) => {
          pattern.lastIndex = 0;
          return pattern.test(file);
        },
      ];
    }
    if (resolved.type !== "ArrayExpression") {
      return undefined;
    }
    const predicates: ((file: string) => boolean)[] = [];
    for (const element of resolved.elements) {
      const parsed = element ? matchers(element) : undefined;
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
  if (!projects || projects.type !== "ArrayExpression") {
    return undefined;
  }
  const namedProjects = new Map<string, Map<string, Node>>();
  const setupNames = new Set<string>();
  for (const project of projects.elements) {
    const fields = properties(project);
    if (!fields) {
      return undefined;
    }
    const name = resolve(fields.get("name"));
    const projectName = name ? stringValue(name) : undefined;
    if (projectName === undefined) {
      return undefined;
    }
    if (namedProjects.has(projectName)) {
      return undefined;
    }
    namedProjects.set(projectName, fields);
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
    const testDirValue = testDir ? stringValue(testDir) : undefined;
    if (testDirExpression && testDirValue === undefined) {
      return undefined;
    }
    const testDirectory = path.resolve(directory, testDirValue ?? ".");
    const relativeDirectory = repoRelativePath(
      root,
      realpathSync(testDirectory),
    );
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
        entries.push(repoRelativePath(root, absolute));
      }
    }
  }
  return entries;
};

// Resolve only static configuration, without executing code from a pull request.
// Unknown configuration is handled by the caller's full-suite fallback.
export const e2eRunnerInputs = (root: string): string[] | undefined => {
  const canonicalRoot = realpathSync(root);
  const absoluteConfig = path.join(canonicalRoot, CONFIG_PATH);
  const source = readFileSync(absoluteConfig, "utf-8");
  new Bun.Transpiler({ loader: "ts" }).scan(source);
  const tree = parseSource(absoluteConfig, source).program;
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
      const relative = repoRelativePath(canonicalRoot, absolute);
      if (relative.startsWith("../") || relative.includes("node_modules/")) {
        return undefined;
      }
      entries.push(relative);
    }
  }
  const setupInputs = setupProjectInputs({
    root: canonicalRoot,
    directory,
    ...reader,
  });
  return setupInputs === undefined ? undefined : [...entries, ...setupInputs];
};
