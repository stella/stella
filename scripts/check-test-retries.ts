/** Prevent automated retries from hiding flaky test behavior. */

import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseSync } from "oxc-parser";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import {
  type ArrayExpression,
  type ArrowFunctionExpression,
  type BindingPattern,
  type BindingRestElement,
  type CallExpression,
  type FormalParameterRest,
  type Function as SyntaxFunction,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  parseSource,
  type Program,
  type TSParameterProperty,
  walk,
} from "../packages/scripts/src/syntax-tree";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const PLAYWRIGHT_CONFIG = /(?:^|\/)playwright[^/]*\.config\.(?:[cm]?[jt]s)$/u;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|tsx|jsx)$/u;
const PACKAGE_FILE = /(?:^|\/)package\.json$/u;
const WORKFLOW_FILE = /^\.github\/(?:workflows|actions)\/.*\.ya?ml$/u;
const PROCESS_CALL_NAMES = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "execa",
  "execaSync",
]);
const TEST_COMMAND =
  /(?:\bbun\b[^;&|\n]*\s(?:test|test:[\w-]+)\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test(?::[\w-]+)?\b|\bdeno\s+test\b|\bturbo\s+run\s+test(?::[\w-]+)?\b|\bplaywright\s+test\b|\b(?:vitest|jest)\b|\brun-tests\.ts\b|\btest-path-filters\.ts\b)/iu;
const RETRY_FLAG =
  /(?:^|\s)--(?:retry|retries|retry-times|rerun-each)(?=$|[\s=])/iu;

export type TestRetryFinding = {
  file: string;
  message: string;
};

type SourceMap = ReadonlyMap<string, string>;

type Source = {
  file: string;
  program: Program;
  root: string;
  text: string;
  unresolvedBindings: ReadonlySet<string>;
  configAncestry: ReadonlySet<string>;
};

type Wrapper =
  "ParenthesizedExpression" | "TSAsExpression" | "TSSatisfiesExpression";

const isPlaywrightConfig = (file: string): boolean =>
  PLAYWRIGHT_CONFIG.test(file);

const isSourceFile = (file: string): boolean => SOURCE_FILE.test(file);

const hasRetryRelevantSyntax = (source: string): boolean =>
  /\b(?:Bun\.)?(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync)\s*\(|(?:describe|test\.describe)\.configure\s*\(/u.test(
    source,
  );

const unwrap = (node: Node, wrappers: readonly Wrapper[]): Node => {
  let value = node;
  while (
    (value.type === "ParenthesizedExpression" ||
      value.type === "TSAsExpression" ||
      value.type === "TSSatisfiesExpression") &&
    wrappers.includes(value.type)
  ) {
    value = value.expression;
  }
  return value;
};

// Numbers read as their value's text, like TypeScript's literal text.
const literalText = (node: Node): string | undefined => {
  if (node.type === "Literal") {
    if (typeof node.value === "string") {
      return node.value;
    }
    if (typeof node.value === "number") {
      return String(node.value);
    }
  }
  return undefined;
};

const propertyName = (property: ObjectProperty): string | undefined => {
  const key = property.key;
  if (property.computed) {
    if (key.type === "TemplateLiteral" && key.expressions.length === 0) {
      return key.quasis.at(0)?.value.cooked ?? undefined;
    }
    return literalText(key);
  }
  return key.type === "Identifier" ? key.name : literalText(key);
};

// A `key: value` entry: neither shorthand nor a method or accessor.
const isPropertyAssignment = (property: ObjectProperty): boolean =>
  !property.shorthand && !property.method && property.kind === "init";

const isObjectExpression = (node: Node): node is ObjectExpression =>
  node.type === "ObjectExpression";

const exportedExpression = (statement: Node): Node | undefined => {
  let expression: Node;
  if (statement.type === "ExportDefaultDeclaration") {
    expression = statement.declaration;
  } else if (statement.type === "TSExportAssignment") {
    expression = statement.expression;
  } else {
    return undefined;
  }
  expression = unwrap(expression, ["TSAsExpression", "TSSatisfiesExpression"]);
  return expression.type === "ChainExpression"
    ? expression.expression
    : expression;
};

// `defineConfig({...})` or a bare object literal.
const configObjectOf = (
  expression: Node,
  source: Source,
): ObjectExpression | undefined => {
  if (isObjectExpression(expression)) {
    return expression;
  }
  if (expression.type !== "CallExpression") {
    return undefined;
  }
  const objects: ObjectExpression[] = [];
  for (const argument of expression.arguments) {
    const object =
      resolveObject(argument, source) ??
      verifiedImportedConfig(argument, source);
    if (object === undefined) {
      return undefined;
    }
    objects.push(object);
  }
  const first = objects.at(0);
  return first === undefined
    ? undefined
    : { ...first, properties: objects.flatMap(({ properties }) => properties) };
};

const devicesByPackage = new Map<string, Record<string, unknown> | undefined>();

/**
 * The `devices` export of the `@playwright/test` the file resolves. Reading
 * the public export keeps presets readable across Playwright releases, which
 * move the data behind it.
 */
export const playwrightDevices = (
  source: Pick<Source, "file" | "root">,
): Record<string, unknown> | undefined => {
  // Dependency resolution and module loading are filesystem boundaries.
  try {
    const entry = createRequire(path.resolve(source.root, source.file)).resolve(
      "@playwright/test",
    );
    if (!devicesByPackage.has(entry)) {
      // The CommonJS entry exports the `test` function with the rest of the
      // API, `devices` included, as its properties.
      const playwrightTest: unknown = createRequire(entry)(entry);
      const devices =
        typeof playwrightTest === "function" || isRecord(playwrightTest)
          ? Reflect.get(playwrightTest, "devices")
          : undefined;
      devicesByPackage.set(entry, isRecord(devices) ? devices : undefined);
    }
    return devicesByPackage.get(entry);
  } catch {
    return undefined;
  }
};

// Resolve imported device presets from the pinned package's literal data,
// rather than exempting spreads by identifier or trusting arbitrary imports.
const resolveDevicePreset = (
  expression: Node,
  source: Source,
): ObjectExpression | undefined => {
  const access =
    expression.type === "ChainExpression" ? expression.expression : expression;
  if (
    access.type !== "MemberExpression" ||
    !access.computed ||
    access.object.type !== "Identifier" ||
    access.property.type !== "Literal" ||
    typeof access.property.value !== "string"
  ) {
    return undefined;
  }
  const binding = access.object.name;
  const presetName = access.property.value;
  const imported = importedBinding(source, binding);
  if (
    imported?.type !== "named" ||
    imported.module !== "@playwright/test" ||
    imported.name !== "devices"
  ) {
    return undefined;
  }
  const descriptor = playwrightDevices(source)?.[presetName];
  if (!isRecord(descriptor)) {
    return undefined;
  }
  // The descriptor is plain data; read it as the object literal it equals.
  try {
    const literal = parseSource(
      "device-preset.ts",
      `export default ${JSON.stringify(descriptor)};`,
    );
    const statement = literal.program.body.at(0);
    const presetExpression =
      statement === undefined ? undefined : exportedExpression(statement);
    return presetExpression?.type === "ObjectExpression"
      ? presetExpression
      : undefined;
  } catch {
    return undefined;
  }
};

const resolveVariable = (name: string, source: Source): Node | undefined => {
  if (source.unresolvedBindings.has(name)) {
    return undefined;
  }
  for (const statement of source.program.body) {
    let declaration: Node = statement;
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration !== null
    ) {
      declaration = statement.declaration;
    }
    if (declaration.type !== "VariableDeclaration") {
      continue;
    }
    const declarator = declaration.declarations.find(
      (entry) => entry.id.type === "Identifier" && entry.id.name === name,
    );
    if (declarator !== undefined && declarator.init !== null) {
      return declarator.init;
    }
  }
  return undefined;
};

const resolveObject = (
  expression: Node,
  source: Source,
  visited = new Set<string>(),
): ObjectExpression | undefined => {
  const value = unwrap(expression, [
    "TSAsExpression",
    "TSSatisfiesExpression",
    "ParenthesizedExpression",
  ]);
  if (value.type === "ObjectExpression") {
    return value;
  }
  const device = resolveDevicePreset(value, source);
  if (device !== undefined) {
    return device;
  }
  if (value.type !== "Identifier" || visited.has(value.name)) {
    return undefined;
  }
  visited.add(value.name);
  const initializer = resolveVariable(value.name, source);
  return initializer === undefined
    ? undefined
    : resolveObject(initializer, source, visited);
};

const numericValue = (expression: Node): number | undefined => {
  const value = unwrap(expression, [
    "ParenthesizedExpression",
    "TSAsExpression",
  ]);
  return value.type === "Literal" && typeof value.value === "number"
    ? value.value
    : undefined;
};

const resolveArray = (
  expression: Node,
  source: Source,
  visited = new Set<string>(),
): ArrayExpression | undefined => {
  const value = unwrap(expression, [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
  ]);
  if (value.type === "ArrayExpression") {
    return value;
  }
  if (value.type !== "Identifier" || visited.has(value.name)) {
    return undefined;
  }
  visited.add(value.name);
  const initializer = resolveVariable(value.name, source);
  return initializer === undefined
    ? undefined
    : resolveArray(initializer, source, visited);
};

const literalCommandPart = (
  expression: Node,
  source: Source,
  visited = new Set<string>(),
): string | undefined => {
  const value = unwrap(expression, [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
  ]);
  if (value.type === "TemplateLiteral") {
    return value.expressions.length === 0
      ? (value.quasis.at(0)?.value.cooked ?? undefined)
      : source.text.slice(value.start, value.end);
  }
  const text = literalText(value);
  if (text !== undefined) {
    return text;
  }
  if (value.type !== "Identifier" || visited.has(value.name)) {
    return undefined;
  }
  visited.add(value.name);
  const initializer = resolveVariable(value.name, source);
  return initializer === undefined
    ? undefined
    : literalCommandPart(initializer, source, visited);
};

const commandArray = (
  expression: Node,
  source: Source,
  visited = new Set<string>(),
): string[] | undefined => {
  const value = unwrap(expression, [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
  ]);
  if (value.type === "Identifier") {
    if (visited.has(value.name)) {
      return undefined;
    }
    visited.add(value.name);
    const initializer = resolveVariable(value.name, source);
    return initializer === undefined
      ? undefined
      : commandArray(initializer, source, visited);
  }
  if (value.type !== "ArrayExpression") {
    return undefined;
  }
  const parts: string[] = [];
  for (const element of value.elements) {
    if (element === null) {
      continue;
    }
    if (element.type === "SpreadElement") {
      const spread = commandArray(element.argument, source, visited);
      if (spread !== undefined) {
        parts.push(...spread);
      }
      continue;
    }
    const part = literalCommandPart(element, source);
    if (part !== undefined) {
      parts.push(part);
    }
  }
  return parts;
};

const processCommand = (
  call: CallExpression,
  source: Source,
): string | undefined => {
  const callee = call.callee;
  let name: string | undefined;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    name = callee.property.name;
  } else if (callee.type === "Identifier") {
    name = callee.name;
  }
  if (name === undefined || !PROCESS_CALL_NAMES.has(name)) {
    return undefined;
  }
  const [first, second] = call.arguments;
  if (first === undefined) {
    return undefined;
  }
  if (first.type === "ObjectExpression") {
    const command = first.properties.find(
      (member): member is ObjectProperty =>
        member.type === "Property" &&
        isPropertyAssignment(member) &&
        propertyName(member) === "cmd",
    );
    if (command !== undefined) {
      const parts = commandArray(command.value, source);
      if (parts !== undefined) {
        return parts.join(" ");
      }
      return literalCommandPart(command.value, source);
    }
  }
  const firstParts = commandArray(first, source);
  if (firstParts !== undefined) {
    return firstParts.join(" ");
  }
  const executable = literalCommandPart(first, source);
  if (executable === undefined) {
    return undefined;
  }
  const secondParts =
    second === undefined ? undefined : commandArray(second, source);
  return [executable, ...(secondParts ?? [])].join(" ");
};

const effectiveRetries = (
  object: ObjectExpression,
  source: Source,
): {
  explicit: boolean;
  value: number | undefined;
  unknownOverride: boolean;
} => {
  let explicit = false;
  let value: number | undefined;
  let unknownOverride = false;
  for (const member of object.properties) {
    if (member.type === "SpreadElement") {
      const spreadObject = resolveObject(member.argument, source);
      if (spreadObject === undefined) {
        unknownOverride = true;
        continue;
      }
      const spread = effectiveRetries(spreadObject, source);
      if (spread.value !== undefined || spread.unknownOverride) {
        value = spread.value;
        unknownOverride = spread.unknownOverride;
      }
      continue;
    }
    // Shorthand values are not literal retry policies; reject them even when
    // a same-named binding happens to be zero today.
    if (member.shorthand && propertyName(member) === "retries") {
      explicit = true;
      value = undefined;
      unknownOverride = false;
      continue;
    }
    if (!isPropertyAssignment(member) || propertyName(member) !== "retries") {
      if (
        isPropertyAssignment(member) &&
        propertyName(member) === undefined &&
        (explicit || value !== undefined)
      ) {
        unknownOverride = true;
      }
      continue;
    }
    explicit = true;
    value = numericValue(member.value);
    unknownOverride = false;
  }
  return { explicit, value, unknownOverride };
};

const hasRetryViolation = (
  retries: ReturnType<typeof effectiveRetries>,
): boolean =>
  (retries.unknownOverride &&
    (retries.explicit || retries.value !== undefined)) ||
  (retries.explicit && retries.value !== 0) ||
  (retries.value !== undefined && retries.value !== 0);

const nestedObjectLiterals = (
  expression: ObjectExpression,
  source: Source,
): { objects: ObjectExpression[]; unknownConfig: boolean } => {
  const objects: ObjectExpression[] = [];
  const active = new Set<Node>();
  let unknownConfig = false;
  const visitExpression = (
    value: Node,
    failClosed = false,
    collect = true,
    projectElements = false,
  ): void => {
    // Either branch of a conditional may be the configuration; both must be
    // readable.
    const branch = unwrap(value, [
      "ParenthesizedExpression",
      "TSAsExpression",
      "TSSatisfiesExpression",
    ]);
    if (branch.type === "ConditionalExpression") {
      visitExpression(branch.consequent, failClosed, collect, projectElements);
      visitExpression(branch.alternate, failClosed, collect, projectElements);
      return;
    }
    const resolved =
      resolveArray(value, source) ?? resolveObject(value, source);
    if (resolved !== undefined) {
      visit(resolved, collect, projectElements);
      return;
    }
    if (failClosed) {
      unknownConfig = true;
    }
  };
  const visit = (
    node: ObjectExpression | ArrayExpression,
    collect = true,
    projectElements = false,
  ): void => {
    if (active.has(node)) {
      unknownConfig = true;
      return;
    }
    active.add(node);
    if (node.type === "ObjectExpression") {
      if (collect) {
        objects.push(node);
      }
      for (const member of node.properties) {
        if (member.type === "SpreadElement") {
          // The containing object's effectiveRetries already evaluates this
          // spread in order; inspect its children without judging overridden values.
          visitExpression(member.argument, true, false);
          continue;
        }
        let name: string | undefined;
        if (member.shorthand || isPropertyAssignment(member)) {
          name = propertyName(member);
        } else {
          continue;
        }
        visitExpression(
          member.value,
          name === "projects" || name === "use",
          true,
          name === "projects",
        );
      }
    } else {
      for (const element of node.elements) {
        if (element === null) {
          // A hole is an element no reader can resolve.
          if (projectElements) {
            unknownConfig = true;
          }
        } else if (element.type === "SpreadElement") {
          visitExpression(element.argument, true, true, projectElements);
        } else {
          visitExpression(element, projectElements, true, projectElements);
        }
      }
    }
    active.delete(node);
  };
  visit(expression);
  return { objects, unknownConfig };
};

// Syntax errors are a finding for configs, so they are read as data here.
const parseConfigSource = (
  file: string,
  text: string,
  root: string,
): Source | undefined => {
  const parsed = parseSync(file, text);
  const hasErrors = parsed.errors.some((error) => {
    // oxc-parser declares Severity as an ambient const enum of strings.
    const severity: string = error.severity;
    return severity === "Error";
  });
  return hasErrors
    ? undefined
    : {
        file,
        program: parsed.program,
        root,
        text,
        unresolvedBindings: new Set<string>(),
        configAncestry: new Set([file]),
      };
};

type ImportedConfigBinding =
  | { type: "named"; module: string; name: string }
  | { type: "namespace"; module: string }
  | { type: "default"; module: string };

const importedBinding = (
  source: Source,
  local: string,
): ImportedConfigBinding | undefined => {
  if (source.unresolvedBindings.has(local)) {
    return undefined;
  }
  for (const statement of source.program.body) {
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type"
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (
        specifier.type === "ImportDefaultSpecifier" &&
        specifier.local.name === local
      ) {
        return { type: "default", module: statement.source.value };
      }
      if (
        specifier.type === "ImportNamespaceSpecifier" &&
        specifier.local.name === local
      ) {
        return { type: "namespace", module: statement.source.value };
      }
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        specifier.local.name === local
      ) {
        const name =
          specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value;
        return { type: "named", module: statement.source.value, name };
      }
    }
  }
  return undefined;
};

// A config helper declared at the top level: `const helper = () => ...`,
// `function helper() {}`, exported or not.
const topLevelFunction = (
  source: Source,
  name: string,
): SyntaxFunction | ArrowFunctionExpression | undefined => {
  for (const statement of source.program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (
      declaration?.type === "FunctionDeclaration" &&
      declaration.id?.name === name
    ) {
      return declaration;
    }
    if (declaration?.type !== "VariableDeclaration") {
      continue;
    }
    for (const declarator of declaration.declarations) {
      const init =
        declarator.init === null
          ? undefined
          : unwrap(declarator.init, [
              "ParenthesizedExpression",
              "TSAsExpression",
              "TSSatisfiesExpression",
            ]);
      if (
        declarator.id.type === "Identifier" &&
        declarator.id.name === name &&
        (init?.type === "ArrowFunctionExpression" ||
          init?.type === "FunctionExpression")
      ) {
        return init;
      }
    }
  }
  return undefined;
};

// What a helper returns: an arrow's expression body, or the one `return` its
// body ends with.
const returnedExpression = (
  helper: SyntaxFunction | ArrowFunctionExpression,
): Node | undefined => {
  const { body } = helper;
  if (body === null) {
    return undefined;
  }
  if (body.type !== "BlockStatement") {
    return body;
  }
  let returnCount = 0;
  walk(body, (node) => {
    // A nested function owns its returns; control-flow blocks do not.
    if (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    ) {
      return "skip-children";
    }
    if (node.type === "ReturnStatement") {
      returnCount += 1;
    }
    return undefined;
  });
  const last = body.body.at(-1);
  return returnCount === 1 &&
    last?.type === "ReturnStatement" &&
    last.argument !== null
    ? last.argument
    : undefined;
};

type ConfigTarget = { object: ObjectExpression; source: Source };

type ConfigBindingPattern =
  | BindingPattern
  | BindingRestElement
  | FormalParameterRest
  | TSParameterProperty;

const bindingNames = (pattern: ConfigBindingPattern): string[] => {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "RestElement":
      return bindingNames(pattern.argument);
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    case "TSParameterProperty":
      return bindingNames(pattern.parameter);
    case "ArrayPattern":
      return pattern.elements.flatMap((element) =>
        element === null ? [] : bindingNames(element),
      );
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        bindingNames(
          property.type === "RestElement" ? property.argument : property.value,
        ),
      );
    default:
      pattern satisfies never;
      return panic("Unexpected configuration binding pattern");
  }
};

const helperBindingNames = (
  helper: SyntaxFunction | ArrowFunctionExpression,
) => {
  const names = new Set(helper.params.flatMap(bindingNames));
  if (helper.type !== "ArrowFunctionExpression" && helper.id !== null) {
    names.add(helper.id.name);
  }
  walk(helper, (node) => {
    if (node.type === "FunctionDeclaration" && node !== helper) {
      if (node.id !== null) {
        names.add(node.id.name);
      }
      return "skip-children";
    }
    if (
      (node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression") &&
      node !== helper
    ) {
      return "skip-children";
    }
    if (node.type === "VariableDeclarator") {
      for (const name of bindingNames(node.id)) {
        names.add(name);
      }
    }
    if (node.type === "ClassDeclaration" && node.id !== null) {
      names.add(node.id.name);
    }
    if (node.type === "CatchClause" && node.param !== null) {
      for (const name of bindingNames(node.param)) {
        names.add(name);
      }
    }
    return undefined;
  });
  return names;
};

const playwrightFactoryLocal = (
  callee: Node,
  source: Source,
): string | undefined => {
  const value = unwrap(callee, [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
  ]);
  if (value.type === "Identifier") {
    const binding = importedBinding(source, value.name);
    return binding?.type === "named" &&
      binding.module === "@playwright/test" &&
      binding.name === "defineConfig"
      ? value.name
      : undefined;
  }
  if (value.type !== "MemberExpression" || value.object.type !== "Identifier") {
    return undefined;
  }
  const member =
    !value.computed && value.property.type === "Identifier"
      ? value.property.name
      : literalText(value.property);
  if (member !== "defineConfig") {
    return undefined;
  }
  const local = value.object.name;
  const binding = importedBinding(source, local);
  return binding?.type === "namespace" && binding.module === "@playwright/test"
    ? local
    : undefined;
};

const scopeForHelper = (
  helper: SyntaxFunction | ArrowFunctionExpression,
  source: Source,
) => ({
  ...source,
  unresolvedBindings: new Set([
    ...source.unresolvedBindings,
    ...helperBindingNames(helper),
  ]),
});

const pureConfigCall = (call: CallExpression, source: Source): boolean => {
  const callee = unwrap(call.callee, [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
  ]);
  if (
    callee.type === "FunctionExpression" ||
    callee.type === "ArrowFunctionExpression"
  ) {
    return !helperHasEffects(callee, scopeForHelper(callee, source));
  }
  if (playwrightFactoryLocal(callee, source) !== undefined) {
    return true;
  }
  if (callee.type === "Identifier") {
    const binding = importedBinding(source, callee.name);
    return (
      binding?.type === "named" &&
      (binding.module === "node:path" || binding.module === "path") &&
      (binding.name === "join" || binding.name === "resolve")
    );
  }
  if (
    callee.type !== "MemberExpression" ||
    callee.object.type !== "Identifier"
  ) {
    return false;
  }
  const member =
    !callee.computed && callee.property.type === "Identifier"
      ? callee.property.name
      : literalText(callee.property);
  const binding = importedBinding(source, callee.object.name);
  return (
    binding !== undefined &&
    (binding.type === "default" || binding.type === "namespace") &&
    (binding.module === "node:path" || binding.module === "path") &&
    (member === "join" || member === "resolve")
  );
};

const CONFIG_EFFECT_NODE_TYPES = new Set([
  "AssignmentExpression",
  "UpdateExpression",
  "NewExpression",
  "TaggedTemplateExpression",
  "ImportExpression",
  "AwaitExpression",
  "YieldExpression",
]);

const helperHasEffects = (
  helper: SyntaxFunction | ArrowFunctionExpression,
  source: Source,
): boolean => {
  let effects = false;
  const returned = returnedExpression(helper);
  walk(helper, (node, ancestors) => {
    if (
      node !== helper &&
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression")
    ) {
      return "skip-children";
    }
    if (
      CONFIG_EFFECT_NODE_TYPES.has(node.type) ||
      (node.type === "UnaryExpression" && node.operator === "delete") ||
      (node.type === "Property" && node.kind !== "init")
    ) {
      effects = true;
    }
    if (node.type === "CallExpression" && !pureConfigCall(node, source)) {
      effects = true;
    }
    // A property read before the return can invoke an unknown getter.
    if (
      node.type === "MemberExpression" &&
      (returned === undefined ||
        node.start < returned.start ||
        node.end > returned.end)
    ) {
      const parent = ancestors.at(-1);
      if (
        parent?.type !== "CallExpression" ||
        parent.callee !== node ||
        !pureConfigCall(parent, source)
      ) {
        effects = true;
      }
    }
    return effects ? "skip-children" : undefined;
  });
  return effects;
};

const helperConfig = (
  helper: SyntaxFunction | ArrowFunctionExpression,
  source: Source,
): ConfigTarget | undefined => {
  const returned = returnedExpression(helper);
  const expression =
    returned === undefined
      ? undefined
      : unwrap(returned, [
          "ParenthesizedExpression",
          "TSAsExpression",
          "TSSatisfiesExpression",
        ]);
  if (expression === undefined) {
    return undefined;
  }
  // Local values are not evaluated; lookups preserve their shadowing rather
  // than falling back to same-named module declarations or imports.
  const helperSource = scopeForHelper(helper, source);
  if (helperHasEffects(helper, helperSource)) {
    return undefined;
  }
  if (expression.type === "CallExpression") {
    const local = playwrightFactoryLocal(expression.callee, helperSource);
    if (local === undefined) {
      return undefined;
    }
  }
  const object = configObjectOf(expression, helperSource);
  return object === undefined ? undefined : { object, source: helperSource };
};

/**
 * The source of a repository module a config imports, or undefined for a
 * package outside the repository (such as `@playwright/test` itself).
 */
const repositoryModule = (
  source: Source,
  specifier: string,
): Source | null | undefined => {
  // Module resolution and reads are filesystem boundaries.
  try {
    const root = realpathSync(source.root);
    const resolved = realpathSync(
      Bun.resolveSync(
        specifier,
        path.dirname(path.resolve(source.root, source.file)),
      ),
    );
    if (!isPathInside(root, resolved)) {
      return undefined;
    }
    const file = repoRelativePath(root, resolved);
    if (file.split("/").includes("node_modules")) {
      return undefined;
    }
    if (source.configAncestry.has(file)) {
      return null;
    }
    const parsed = parseConfigSource(
      file,
      readFileSync(resolved, "utf-8"),
      source.root,
    );
    return parsed === undefined
      ? null
      : {
          ...parsed,
          configAncestry: new Set([...source.configAncestry, file]),
        };
  } catch {
    return null;
  }
};

/**
 * The object a config exports. A config built by a helper in this repository
 * (`export default sharedConfig({...})`) is read from the object the helper
 * returns; a helper the reader cannot follow yields no config, which fails
 * closed.
 */
const configTarget = (source: Source): ConfigTarget | undefined => {
  for (const statement of source.program.body) {
    const expression = exportedExpression(statement);
    if (expression === undefined) {
      continue;
    }
    if (
      expression.type === "CallExpression" &&
      expression.callee.type === "Identifier"
    ) {
      const local = expression.callee.name;
      const imported = importedBinding(source, local);
      if (imported !== undefined && imported.type !== "named") {
        return undefined;
      }
      let module: Source | null | undefined = source;
      if (imported !== undefined) {
        module =
          imported.module === "@playwright/test"
            ? undefined
            : repositoryModule(source, imported.module);
      }
      if (module === null) {
        return undefined;
      }
      if (module !== undefined) {
        const helper = topLevelFunction(module, imported?.name ?? local);
        if (helper !== undefined) {
          return helperConfig(helper, module);
        }
        if (imported !== undefined) {
          return undefined;
        }
      }
    }
    const object = configObjectOf(expression, source);
    if (object !== undefined) {
      return { object, source };
    }
  }
  return undefined;
};

const configFindings = (
  target: ConfigTarget,
  file: string,
): TestRetryFinding[] => {
  const { object, source } = target;
  const retries = effectiveRetries(object, source);
  const findings: TestRetryFinding[] = [];
  if (!retries.explicit || retries.value !== 0 || retries.unknownOverride) {
    findings.push({
      file,
      message:
        "Playwright config must explicitly set top-level retries: 0 as its effective value",
    });
  }
  const nested = nestedObjectLiterals(object, source);
  if (nested.unknownConfig) {
    findings.push({
      file,
      message:
        "Playwright project/use configuration is not statically inspectable",
    });
  }
  for (const nestedObject of nested.objects.slice(1)) {
    if (hasRetryViolation(effectiveRetries(nestedObject, source))) {
      findings.push({
        file,
        message: "Playwright project/use retries must be statically set to 0",
      });
    }
  }
  return findings;
};

const verifiedImportedConfig = (
  argument: Node,
  source: Source,
): ObjectExpression | undefined => {
  const value = unwrap(argument, [
    "ParenthesizedExpression",
    "TSAsExpression",
    "TSSatisfiesExpression",
  ]);
  if (value.type !== "Identifier") {
    return undefined;
  }
  const binding = importedBinding(source, value.name);
  if (
    binding === undefined ||
    (binding.type !== "default" &&
      !(binding.type === "named" && binding.name === "default"))
  ) {
    return undefined;
  }
  const module = repositoryModule(source, binding.module);
  if (module === undefined || module === null) {
    return undefined;
  }
  const target = configTarget(module);
  if (
    target === undefined ||
    configFindings(target, module.file).length !== 0
  ) {
    return undefined;
  }
  // The entire base passed the policy, including inherited project/use
  // settings. Compose only its verified scalar policy in the caller's scope.
  const parsed = parseSource(
    "verified-config.ts",
    "export default { retries: 0 };",
  );
  const statement = parsed.program.body.at(0);
  const expression =
    statement === undefined ? undefined : exportedExpression(statement);
  return expression?.type === "ObjectExpression" ? expression : undefined;
};

const scanConfig = (
  file: string,
  sourceText: string,
  root: string,
): TestRetryFinding[] => {
  const parsed = parseConfigSource(file, sourceText, root);
  if (parsed === undefined) {
    return [{ file, message: "Playwright config has TypeScript parse errors" }];
  }
  const target = configTarget(parsed);
  return target === undefined
    ? [
        {
          file,
          message: "Playwright config must explicitly set top-level retries: 0",
        },
      ]
    : configFindings(target, file);
};

const scanTestSource = (
  file: string,
  sourceText: string,
  root: string,
): TestRetryFinding[] => {
  const source: Source = {
    file,
    program: parseSource(file, sourceText).program,
    root,
    text: sourceText,
    unresolvedBindings: new Set<string>(),
    configAncestry: new Set([file]),
  };
  const findings: TestRetryFinding[] = [];
  walk(source.program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const command = processCommand(node, source);
    if (command !== undefined) {
      findings.push(...scanCommand(file, command, "TS/JS process invocation"));
    }
    const callee = node.callee;
    const isConfigure =
      callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.property.type === "Identifier" &&
      callee.property.name === "configure" &&
      ["describe", "test.describe"].includes(
        sourceText.slice(callee.object.start, callee.object.end),
      );
    if (isConfigure) {
      const [options] = node.arguments;
      const resolvedOptions =
        options === undefined ? undefined : resolveObject(options, source);
      if (
        resolvedOptions === undefined ||
        hasRetryViolation(effectiveRetries(resolvedOptions, source))
      ) {
        findings.push({
          file,
          message:
            "test.describe.configure has dynamic or nonzero retry settings",
        });
      }
    }
  });
  return findings;
};

const hasTestCommand = (command: string): boolean => TEST_COMMAND.test(command);

const scanCommand = (
  file: string,
  command: string,
  context: string,
): TestRetryFinding[] => {
  const findings: TestRetryFinding[] = [];
  const commands = command.replace(/\\\r?\n/gu, " ").split(/&&|\|\||;|\r?\n/u);
  for (const segment of commands) {
    if (!hasTestCommand(segment)) {
      continue;
    }
    if (RETRY_FLAG.test(segment.replace(/["']/gu, ""))) {
      findings.push({
        file,
        message: `${context} passes a test retry option`,
      });
    }
    if (
      /\b(?:bash\s+)?(?:\.\/)?(?:\.workflow-source\/|\.workflow-tooling\/)?scripts\/retry\.sh\b/iu.test(
        segment,
      )
    ) {
      findings.push({
        file,
        message: `${context} wraps a test command in scripts/retry.sh`,
      });
    }
  }
  return findings;
};

const scanPackage = (file: string, sourceText: string): TestRetryFinding[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sourceText);
  } catch {
    return [{ file, message: "package.json is not valid JSON" }];
  }
  if (typeof parsed !== "object" || parsed === null || !("scripts" in parsed)) {
    return [];
  }
  const scripts = parsed.scripts;
  if (scripts === undefined) {
    return [];
  }
  if (
    typeof scripts !== "object" ||
    scripts === null ||
    Array.isArray(scripts)
  ) {
    return [{ file, message: "package.json scripts must be an object" }];
  }
  return Object.entries(scripts).flatMap(([name, command]) => {
    if (typeof command !== "string") {
      return [];
    }
    return scanCommand(file, command, `package script ${name}`);
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scanWorkflow = (file: string, sourceText: string): TestRetryFinding[] => {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(sourceText);
  } catch {
    return [{ file, message: "workflow/action YAML is invalid" }];
  }
  if (!isRecord(parsed)) {
    return [{ file, message: "workflow/action YAML must have a mapping root" }];
  }
  if (
    (file.startsWith(".github/workflows/") && !isRecord(parsed["jobs"])) ||
    (file.startsWith(".github/actions/") && !isRecord(parsed["runs"]))
  ) {
    return [
      {
        file,
        message: "workflow/action YAML is missing its jobs/runs mapping",
      },
    ];
  }
  const findings: TestRetryFinding[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    const inputs: string[] = [];
    for (const key of ["run", "command", "script"]) {
      const input = value[key];
      if (typeof input === "string") {
        inputs.push(input);
      }
    }
    const withInputs = value["with"];
    const actionInputs: string[] = [...inputs];
    if (isRecord(withInputs)) {
      for (const key of ["command", "script"]) {
        const input = withInputs[key];
        if (typeof input === "string") {
          actionInputs.push(input);
        }
      }
    }
    const commands = inputs.join("\n");
    findings.push(...scanCommand(file, commands, "workflow/action step"));
    const uses = value["uses"];
    if (
      typeof uses === "string" &&
      /(?:^|\/)[^/]*retry[^/]*(?:@|$)/iu.test(uses) &&
      hasTestCommand(actionInputs.join("\n"))
    ) {
      findings.push({
        file,
        message: "workflow/action retry step wraps a test command",
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "with") {
        visit(child);
      }
    }
    visit(withInputs);
  };
  visit(parsed);
  return findings;
};

export const findTestRetryViolations = (
  sources: SourceMap,
  root = REPO_ROOT,
): TestRetryFinding[] => {
  const findings: TestRetryFinding[] = [];
  for (const [file, source] of sources) {
    if (isPlaywrightConfig(file)) {
      findings.push(...scanConfig(file, source, root));
    }
    if (isSourceFile(file) && hasRetryRelevantSyntax(source)) {
      findings.push(...scanTestSource(file, source, root));
    }
    if (file.endsWith(".sh")) {
      const commands = source
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
      findings.push(...scanCommand(file, commands, "shell launcher"));
    }
    if (PACKAGE_FILE.test(file)) {
      findings.push(...scanPackage(file, source));
    }
    if (WORKFLOW_FILE.test(file)) {
      findings.push(...scanWorkflow(file, source));
    }
  }
  return findings;
};

const trackedSources = (root: string): Map<string, string> => {
  const files = execFileSync("git", ["ls-files", "-z"], {
    maxBuffer: 2 ** 30,
    cwd: root,
    encoding: "utf-8",
  })
    .split("\0")
    .filter(
      (file) =>
        isPlaywrightConfig(file) ||
        isSourceFile(file) ||
        file.endsWith(".sh") ||
        PACKAGE_FILE.test(file) ||
        WORKFLOW_FILE.test(file),
    );
  const sources = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf-8");
    // Only sources that spawn or configure tests are scanned as code; every
    // Playwright config is read, since its top-level retries is the policy.
    if (
      isSourceFile(file) &&
      !isPlaywrightConfig(file) &&
      !hasRetryRelevantSyntax(source)
    ) {
      continue;
    }
    sources.set(file, source);
  }
  return sources;
};

export const checkTestRetries = (root = REPO_ROOT): TestRetryFinding[] =>
  findTestRetryViolations(trackedSources(root), root);

if (import.meta.main) {
  const findings = checkTestRetries();
  if (findings.length > 0) {
    for (const finding of findings) {
      process.stderr.write(`${finding.file}: ${finding.message}\n`);
    }
    process.exitCode = 1;
  } else {
    process.stdout.write("Test retry guard passed.\n");
  }
}
