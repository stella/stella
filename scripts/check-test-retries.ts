/** Prevent automated retries from hiding flaky test behavior. */

import { panic } from "better-result";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";

import { isPathInside, repoRelativePath } from "@stll/portable-path";

import {
  devices,
  isDevicePresetName,
} from "../packages/playwright-tools/src/devices";
import {
  type ArrayExpression,
  type CallExpression,
  type Node,
  type ObjectExpression,
  type ObjectProperty,
  parseSource,
  type Program,
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
  type: "playwright" | "test";
  file: string;
  program: Program;
  root: string;
  text: string;
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

// Runtime configuration and policy inspection share the same frozen presets.
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
    (imported.module !== "@stll/playwright-tools/devices" &&
      !(
        source.file === "packages/playwright-tools/src/marketing-config.ts" &&
        imported.module === "./devices"
      )) ||
    imported.name !== "devices"
  ) {
    return undefined;
  }
  if (!isDevicePresetName(presetName)) {
    return undefined;
  }
  const descriptor = devices[presetName];
  const literal = parseSource(
    "device-preset.ts",
    `export default ${JSON.stringify(descriptor)};`,
  );
  const statement = literal.program.body.at(0);
  const presetExpression =
    statement === undefined ? undefined : exportedExpression(statement);
  return presetExpression?.type === "ObjectExpression"
    ? presetExpression
    : panic("A generated device descriptor must be an object");
};

const resolveVariable = (name: string, source: Source): Node | undefined => {
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
  if (source.type === "playwright" && !staticConfigModule(source)) {
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
  if (source.type === "playwright" && !staticConfigModule(source)) {
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
        if (member.kind !== "init") {
          unknownConfig = true;
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
        type: "playwright",
        file,
        program: parsed.program,
        root,
        text,
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

type ConfigTarget = { object: ObjectExpression; source: Source };

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

const staticConfigCall = (callee: Node, source: Source): boolean => {
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
  const binding = importedBinding(source, callee.object.name);
  const member =
    !callee.computed && callee.property.type === "Identifier"
      ? callee.property.name
      : literalText(callee.property);
  return (
    binding !== undefined &&
    (binding.type === "default" || binding.type === "namespace") &&
    (binding.module === "node:path" || binding.module === "path") &&
    (member === "join" || member === "resolve")
  );
};

const DYNAMIC_CONFIG_NODE_TYPES = new Set([
  "AssignmentExpression",
  "UpdateExpression",
  "NewExpression",
  "TaggedTemplateExpression",
  "ImportExpression",
  "AwaitExpression",
  "YieldExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ClassExpression",
]);

const isErasedConfigStatement = (statement: Node): boolean => {
  if (
    statement.type === "TSTypeAliasDeclaration" ||
    statement.type === "TSInterfaceDeclaration"
  ) {
    return true;
  }
  if (statement.type !== "ExportNamedDeclaration") {
    return false;
  }
  if (statement.declaration !== null) {
    return (
      statement.declaration.type === "TSTypeAliasDeclaration" ||
      statement.declaration.type === "TSInterfaceDeclaration"
    );
  }
  return (
    statement.exportKind === "type" ||
    (statement.specifiers.length > 0 &&
      statement.specifiers.every(
        (specifier) => specifier.exportKind === "type",
      ))
  );
};

// Named policy data must retain the value of its literal initializer.
// Restrict its construction module before resolving bindings, so statements
// and calls cannot change those objects before composition.
const staticConfigModule = (source: Source): boolean => {
  const declarationsOnly = source.program.body.every((statement) => {
    if (
      statement.type === "ImportDeclaration" ||
      statement.type === "ExportDefaultDeclaration" ||
      statement.type === "EmptyStatement" ||
      isErasedConfigStatement(statement)
    ) {
      return true;
    }
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    return (
      declaration?.type === "VariableDeclaration" &&
      declaration.kind === "const"
    );
  });
  if (!declarationsOnly) {
    return false;
  }
  let readable = true;
  walk(source.program, (node) => {
    if (isErasedConfigStatement(node)) {
      return "skip-children";
    }
    if (
      DYNAMIC_CONFIG_NODE_TYPES.has(node.type) ||
      (node.type === "UnaryExpression" && node.operator === "delete") ||
      (node.type === "Property" && node.kind !== "init") ||
      (node.type === "CallExpression" && !staticConfigCall(node.callee, source))
    ) {
      readable = false;
    }
    return readable ? undefined : "skip-children";
  });
  return readable;
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

// Configuration roots are literal data or the imported Playwright factory.
// Repository functions stay opaque: reading their return values cannot prove
// the configuration that executing them produces.
const configTarget = (source: Source): ConfigTarget | undefined => {
  for (const statement of source.program.body) {
    const expression = exportedExpression(statement);
    if (expression === undefined) {
      continue;
    }
    if (
      expression.type === "CallExpression" &&
      playwrightFactoryLocal(expression.callee, source) === undefined
    ) {
      return undefined;
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
  if (!staticConfigModule(source)) {
    return undefined;
  }
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

const runtimeModuleSpecifiers = (source: Source): string[] | undefined => {
  const specifiers: string[] = [];
  const dynamicImports = new Set<Node>();
  walk(source.program, (node) => {
    if (
      node.type === "ImportExpression" ||
      node.type === "TSImportEqualsDeclaration" ||
      (node.type === "Identifier" &&
        (node.name === "require" || node.name === "eval"))
    ) {
      dynamicImports.add(node);
    }
  });
  for (const statement of source.program.body) {
    if (statement.type === "ImportDeclaration") {
      if (
        statement.importKind === "type" ||
        (statement.specifiers.length > 0 &&
          statement.specifiers.every(
            (specifier) =>
              specifier.type === "ImportSpecifier" &&
              specifier.importKind === "type",
          ))
      ) {
        continue;
      }
      specifiers.push(statement.source.value);
    } else if (
      (statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration") &&
      statement.exportKind !== "type" &&
      statement.source !== null
    ) {
      specifiers.push(statement.source.value);
    }
  }
  return dynamicImports.size === 0 && !specifiers.includes("node:module")
    ? specifiers
    : undefined;
};

const importedRepositoryModule = (source: Source, specifier: string) => {
  const module = repositoryModule(
    { ...source, configAncestry: new Set() },
    specifier,
  );
  if (module !== null) {
    return module;
  }
  return specifier.startsWith(".") ||
    specifier.startsWith("@stll/") ||
    path.isAbsolute(specifier)
    ? null
    : undefined;
};

const composedConfigurationSources = (source: Source) => {
  const configs = new Map([[source.file, source]]);
  for (const config of configs.values()) {
    for (const statement of config.program.body) {
      const expression = exportedExpression(statement);
      if (expression?.type !== "CallExpression") {
        continue;
      }
      for (const argument of expression.arguments) {
        const value = unwrap(argument, [
          "ParenthesizedExpression",
          "TSAsExpression",
          "TSSatisfiesExpression",
        ]);
        const binding =
          value.type === "Identifier"
            ? importedBinding(config, value.name)
            : undefined;
        if (
          binding?.type !== "default" &&
          !(binding?.type === "named" && binding.name === "default")
        ) {
          continue;
        }
        const module = importedRepositoryModule(config, binding.module);
        if (module !== undefined && module !== null) {
          configs.set(module.file, module);
        }
      }
    }
  }
  return configs;
};

// Follow static repository edges, not helper execution. A module outside
// configuration composition must never acquire a mutable configuration base.
const isolatedConfigurationImports = (source: Source): boolean => {
  const configs = composedConfigurationSources(source);
  const pending = [source];
  const visited = new Set<string>();
  for (const current of pending) {
    if (visited.has(current.file)) {
      continue;
    }
    visited.add(current.file);
    const specifiers = runtimeModuleSpecifiers(current);
    if (specifiers === undefined) {
      return false;
    }
    for (const specifier of specifiers) {
      const module = importedRepositoryModule(current, specifier);
      if (module === null) {
        return false;
      }
      if (module === undefined) {
        continue;
      }
      if (
        configs.has(module.file) &&
        (!configs.has(current.file) || !staticConfigModule(current))
      ) {
        return false;
      }
      pending.push(module);
    }
  }
  return true;
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
  const target = isolatedConfigurationImports(parsed)
    ? configTarget(parsed)
    : undefined;
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
    type: "test",
    file,
    program: parseSource(file, sourceText).program,
    root,
    text: sourceText,
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
