import { panic } from "better-result";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  type Expression,
  type ModuleExportName,
  type ObjectProperty,
  type ParsedSource,
  parseSource,
  type SpreadElement,
  walk,
} from "@stll/scripts/src/syntax-tree";

import { canonicalModuleId } from "../../../../.oxlint-plugins/module-id.ts";
import { VERIFICATION_MODEL_TASK } from "../../src/lib/lists/verification/model-call";
import { REPO_ROOT } from "./enumerate-safe-handlers";

type ConditionalOperation = {
  file: string;
  line: number;
  checker: "authorizeHandlerUsage" | "authorizeHandlerRunSize";
  metering: unknown;
};

const checkerName = (value: string) => {
  switch (value) {
    case "authorizeHandlerUsage":
    case "authorizeHandlerRunSize":
      return value;
    default:
      return undefined;
  }
};

const CHECKER_MODULE = "apps/api/src/lib/api-handlers";

type ResolveCheckerExportOptions = {
  moduleId: string;
  exportedName: string;
  sources: Map<string, ParsedSource | undefined>;
  visited?: Set<string>;
};

const moduleExportName = (name: ModuleExportName) =>
  name.type === "Literal" ? name.value : name.name;

const resolveCheckerExport = ({
  moduleId,
  exportedName,
  sources,
  visited = new Set<string>(),
}: ResolveCheckerExportOptions):
  ConditionalOperation["checker"] | undefined => {
  const checker = checkerName(exportedName);
  if (moduleId === CHECKER_MODULE) {
    return checker;
  }
  const visitKey = `${moduleId}:${exportedName}`;
  if (visited.has(visitKey)) {
    return undefined;
  }
  visited.add(visitKey);
  const moduleFile = `${moduleId}.ts`;
  if (!sources.has(moduleFile)) {
    const absoluteModuleFile = path.join(REPO_ROOT, moduleFile);
    sources.set(
      moduleFile,
      existsSync(absoluteModuleFile)
        ? parseSource(moduleFile, readFileSync(absoluteModuleFile, "utf-8"))
        : undefined,
    );
  }
  const source = sources.get(moduleFile);
  if (source === undefined) {
    return undefined;
  }
  for (const statement of source.program.body) {
    if (
      statement.type !== "ExportNamedDeclaration" ||
      statement.source === null
    ) {
      continue;
    }
    for (const element of statement.specifiers) {
      if (moduleExportName(element.exported) !== exportedName) {
        continue;
      }
      return resolveCheckerExport({
        moduleId: canonicalModuleId(statement.source.value, moduleFile),
        exportedName: moduleExportName(element.local),
        sources,
        visited,
      });
    }
  }
  return undefined;
};

// A `name: value` entry; shorthand, method, accessor and spread entries are not.
const isPropertyAssignment = (
  property: ObjectProperty | SpreadElement,
): property is ObjectProperty =>
  property.type === "Property" &&
  property.kind === "init" &&
  !property.method &&
  !property.shorthand;

const propertyNameText = (text: string, property: ObjectProperty) => {
  const name = text.slice(property.key.start, property.key.end);
  return property.computed ? `[${name}]` : name;
};

const readMeteringValue = (text: string, node: Expression): unknown => {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "ConditionalExpression") {
    return readMeteringValue(text, node.consequent);
  }
  if (node.type === "ObjectExpression") {
    return Object.fromEntries(
      node.properties.map((property) => {
        if (!isPropertyAssignment(property)) {
          return panic("Admission census requires explicit metering fields");
        }
        return [
          propertyNameText(text, property),
          readMeteringValue(text, property.value),
        ];
      }),
    );
  }
  if (node.type === "Identifier" && node.name === "VERIFICATION_MODEL_TASK") {
    return VERIFICATION_MODEL_TASK;
  }
  return panic(
    `Admission census cannot resolve ${text.slice(node.start, node.end)}`,
  );
};

type EnumerateConditionalOperationsOptions = { file: string; text: string };

export const enumerateConditionalOperations = ({
  file,
  text,
}: EnumerateConditionalOperationsOptions): ConditionalOperation[] =>
  enumerateWithSources({ file, text, sources: new Map() });

type EnumerateWithSourcesOptions = EnumerateConditionalOperationsOptions & {
  sources: Map<string, ParsedSource | undefined>;
};

const enumerateWithSources = ({
  file,
  text,
  sources,
}: EnumerateWithSourcesOptions): ConditionalOperation[] => {
  const operations: ConditionalOperation[] = [];
  const source = parseSource(file, text);
  const aliases = new Map<string, ConditionalOperation["checker"]>();
  const namespaces = new Map<string, string>();
  for (const statement of source.program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const moduleId = canonicalModuleId(statement.source.value, file);
    for (const binding of statement.specifiers) {
      if (binding.type === "ImportNamespaceSpecifier") {
        namespaces.set(binding.local.name, moduleId);
      }
      if (binding.type === "ImportSpecifier") {
        const checker = resolveCheckerExport({
          moduleId,
          exportedName: moduleExportName(binding.imported),
          sources,
        });
        if (checker) {
          aliases.set(binding.local.name, checker);
        }
      }
    }
  }
  // Handler factories retain the real checker as an injectable default.
  walk(source.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (
      node.type === "AssignmentPattern" &&
      // A destructured binding's default, not a parameter's.
      (parent?.type === "ArrayPattern" ||
        (parent?.type === "Property" &&
          ancestors.at(-2)?.type === "ObjectPattern")) &&
      node.left.type === "Identifier" &&
      node.right.type === "Identifier"
    ) {
      const checker = aliases.get(node.right.name);
      if (checker !== undefined) {
        aliases.set(node.left.name, checker);
      }
    }
  });
  walk(source.program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const expression = node.callee;
    let checker: ConditionalOperation["checker"] | undefined;
    if (expression.type === "Identifier") {
      checker = aliases.get(expression.name);
    } else if (
      expression.type === "MemberExpression" &&
      !expression.computed &&
      expression.object.type === "Identifier" &&
      expression.property.type === "Identifier" &&
      namespaces.has(expression.object.name)
    ) {
      checker = resolveCheckerExport({
        moduleId:
          namespaces.get(expression.object.name) ?? panic("Missing namespace"),
        exportedName: expression.property.name,
        sources,
      });
    }
    if (checker) {
      const input = node.arguments.at(0);
      if (input?.type !== "ObjectExpression") {
        panic(`Admission census requires an explicit input at ${file}`);
      }
      const metering = input.properties
        .filter(isPropertyAssignment)
        .find((property) => propertyNameText(text, property) === "metering");
      if (!metering) {
        panic(`Admission census lacks metering at ${file}`);
      }
      operations.push({
        file,
        line: source.locate(node.start).line,
        checker,
        metering: readMeteringValue(text, metering.value),
      });
    }
  });
  return operations;
};

export const discoverConditionalOperations = async (): Promise<
  ConditionalOperation[]
> => {
  const operations: ConditionalOperation[] = [];
  // Imported modules recur across symbols and owners. Cache only their parsed
  // syntax for this census; resolution and operation collection still run anew.
  const sources = new Map<string, ParsedSource | undefined>();
  for await (const file of new Bun.Glob("apps/api/src/**/*.ts").scan({
    cwd: REPO_ROOT,
  })) {
    if (file.includes("/tests/") || file.endsWith(".test.ts")) {
      continue;
    }
    const text = await Bun.file(path.join(REPO_ROOT, file)).text();
    operations.push(...enumerateWithSources({ file, text, sources }));
  }
  return operations;
};
