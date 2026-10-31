import { panic, Result } from "better-result";

import { compareCodeUnit } from "@stll/collation";

import {
  type BindingPattern,
  type BindingRestElement,
  type Expression,
  type FormalParameterRest,
  type Node,
  type ParsedSource,
  parseSource,
  staticPropertyName,
  walk,
} from "../packages/scripts/src/syntax-tree";
import {
  readReleaseAgeExceptions,
  readTemporaryExcludes,
} from "./check-stll-quarantine-excludes";
import { readTestQuarantines } from "./dated-waiver-core";
import {
  readAuditAcceptanceOwner,
  readDocumentationOwner,
} from "./dated-waiver-probes";
import type { DatedWaiver } from "./dated-waivers";
import { parseRegistry } from "./flaky-test-quarantine";
import { parseLedger } from "./suppression-waivers";

const unique = <T>(
  matches: readonly T[],
  entry: DatedWaiver,
): T | undefined => {
  if (matches.length > 1) {
    panic(`Ambiguous dated waiver identity: ${entry.source}:${entry.id}`);
  }
  return matches.at(0);
};

const declarationsIn = (ast: ParsedSource) => {
  // Top-level constants and function declarations: an entry that reads one
  // changes when it does.
  const declarations = new Map<string, Expression | Node>();
  for (const statement of ast.program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      declarations.set(declaration.id.name, declaration);
      continue;
    }
    if (declaration?.type !== "VariableDeclaration") {
      continue;
    }
    for (const variable of declaration.declarations) {
      if (variable.id.type === "Identifier" && variable.init) {
        declarations.set(variable.id.name, variable.init);
      }
    }
  }
  return declarations;
};

// Locations and literal spellings are parser metadata, not waiver fields.
// Resolve top-level constants so editing a shared deadline or rationale edits
// every entry that consumes it, without treating sibling insertions as edits.
const AST_METADATA = new Set(["start", "end", "loc", "range", "raw"]);

const bindingNames = (
  node: BindingPattern | BindingRestElement | FormalParameterRest,
): string[] => {
  switch (node.type) {
    case "Identifier":
      return [node.name];
    case "ArrayPattern":
      return node.elements.flatMap((item) => (item ? bindingNames(item) : []));
    case "ObjectPattern":
      return node.properties.flatMap((property) =>
        bindingNames(
          property.type === "RestElement" ? property.argument : property.value,
        ),
      );
    case "AssignmentPattern":
      return bindingNames(node.left);
    case "RestElement":
      return bindingNames(node.argument);
    default:
      node satisfies never;
      return panic("Unknown binding pattern");
  }
};

const localBindingsIn = (ast: ParsedSource) => {
  const bindings = new Map<object, readonly string[]>();
  walk(ast.program, (node) => {
    if (
      node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression" ||
      node.type === "FunctionDeclaration"
    ) {
      bindings.set(node, [
        ...node.params.flatMap((parameter) =>
          bindingNames(
            parameter.type === "TSParameterProperty"
              ? parameter.parameter
              : parameter,
          ),
        ),
        ...(node.type !== "ArrowFunctionExpression" && node.id
          ? [node.id.name]
          : []),
      ]);
    }
    if (node.type === "BlockStatement") {
      bindings.set(
        node,
        node.body.flatMap((statement) => {
          if (statement.type === "VariableDeclaration") {
            return statement.declarations.flatMap(({ id }) => bindingNames(id));
          }
          if (
            (statement.type === "FunctionDeclaration" ||
              statement.type === "ClassDeclaration") &&
            statement.id
          ) {
            return [statement.id.name];
          }
          return [];
        }),
      );
    }
  });
  return bindings;
};

type SemanticScope = {
  references: ReadonlySet<string>;
  locals: ReadonlySet<string>;
};
const semanticTree = (ast: ParsedSource, node: Node): unknown => {
  const declarations = declarationsIn(ast);
  const localBindings = localBindingsIn(ast);
  const normalize = (
    value: unknown,
    scope: SemanticScope,
    key?: string,
    computed = false,
  ): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item, scope));
    }
    if (typeof value !== "object" || value === null) {
      return value;
    }
    const bound = localBindings.get(value);
    const current =
      bound === undefined
        ? scope
        : {
            references: scope.references,
            locals: new Set([...scope.locals, ...bound]),
          };
    if (
      "type" in value &&
      (value.type === "ParenthesizedExpression" ||
        value.type === "TSSatisfiesExpression" ||
        value.type === "TSAsExpression" ||
        value.type === "TSNonNullExpression") &&
      "expression" in value
    ) {
      return normalize(value.expression, current);
    }
    if (
      "type" in value &&
      value.type === "Identifier" &&
      "name" in value &&
      typeof value.name === "string" &&
      // A static key or member name is a spelling; a computed one is a read.
      (computed || (key !== "key" && key !== "property")) &&
      !current.locals.has(value.name)
    ) {
      const declaration = declarations.get(value.name);
      if (declaration !== undefined) {
        if (current.references.has(value.name)) {
          // Recursion: the declaration is already being compared.
          return { reference: value.name };
        }
        return normalize(declaration, {
          references: new Set([...current.references, value.name]),
          locals: new Set(),
        });
      }
    }
    return Object.fromEntries(
      Object.entries(value)
        .filter(([name]) => !AST_METADATA.has(name))
        .toSorted(([left], [right]) => compareCodeUnit(left, right))
        .map(([name, field]) => [
          name,
          normalize(
            field,
            current,
            name,
            "computed" in value && value.computed === true,
          ),
        ]),
    );
  };
  return normalize(node, { references: new Set(), locals: new Set() });
};

const objectEntry = (entry: DatedWaiver, source: string) => {
  const ast = parseSource(entry.source, source);
  const identity = entry.kind === "pending-contract-migration" ? "name" : "id";
  const matches: Node[] = [];
  walk(ast.program, (node) => {
    if (
      node.type === "ObjectExpression" &&
      node.properties.some(
        (property) =>
          property.type === "Property" &&
          !property.method &&
          staticPropertyName(property) === identity &&
          property.value.type === "Literal" &&
          property.value.value === entry.id,
      )
    ) {
      matches.push(node);
    }
  });
  const match = unique(matches, entry);
  return match === undefined ? undefined : semanticTree(ast, match);
};

/** The complete declaration of one identity; absence is distinct from a bad read. */
export const waiverEntryFields = (
  entry: DatedWaiver,
  source: string,
): unknown | undefined => {
  switch (entry.kind) {
    case "no-llms-txt": {
      const { ast, sites } = readDocumentationOwner(source);
      const site = unique(
        sites.filter(({ dependency }) => dependency === entry.id),
        entry,
      );
      return site === undefined
        ? undefined
        : {
            item: semanticTree(ast, site.node),
            declaration: semanticTree(ast, site.declaration),
            checkedAt: site.checkedAt?.value,
            expiresAt: site.expiresAt?.value,
          };
    }
    case "dependency-audit":
      return unique(
        readAuditAcceptanceOwner(source).accepted.filter(
          ({ id }) => id === entry.id,
        ),
        entry,
      );
    case "suppression-waiver": {
      const parsed = parseLedger(JSON.parse(source));
      if (parsed.status === "invalid") {
        return panic(parsed.errors.join("\n"));
      }
      return unique(
        parsed.ledger.waivers.filter(({ id }) => id === entry.id),
        entry,
      );
    }
    case "flaky-test-quarantine": {
      const parsed = parseRegistry(JSON.parse(source));
      if (parsed.status === "invalid") {
        return panic(parsed.errors.join("\n"));
      }
      return unique(
        parsed.registry.entries.filter(({ id }) => id === entry.id),
        entry,
      );
    }
    case "release-age-exclusion": {
      const parsed = readTemporaryExcludes(source);
      if (parsed.errors.length > 0) {
        return panic(parsed.errors.join("\n"));
      }
      return unique(
        parsed.entries.filter(({ name }) => name === entry.id),
        entry,
      );
    }
    case "release-age-exception": {
      const parsed = readReleaseAgeExceptions({ [entry.source]: source });
      if (parsed.errors.length > 0) {
        return panic(parsed.errors.join("\n"));
      }
      const lines = source.split("\n");
      const match = unique(
        parsed.entries.filter(
          ({ line }) => lines.at(line - 2)?.trim() === entry.id,
        ),
        entry,
      );
      return match === undefined
        ? undefined
        : { command: entry.id, expiresAt: match.expiresAt };
    }
    case "quarantined-test": {
      const match = unique(
        readTestQuarantines({ [entry.source]: source }).filter(
          ({ id }) => id === entry.id,
        ),
        entry,
      );
      if (match === undefined) {
        return undefined;
      }
      const ast = parseSource(entry.source, source);
      const calls: Node[] = [];
      walk(ast.program, (node) => {
        const title =
          node.type === "CallExpression" ? node.arguments.at(0) : undefined;
        if (
          node.type === "CallExpression" &&
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.object.type === "Identifier" &&
          ["test", "it"].includes(node.callee.object.name) &&
          node.callee.property.type === "Identifier" &&
          node.callee.property.name === "skip" &&
          ast.locate(node.start).line === match.line &&
          title?.type === "Literal" &&
          title.value === entry.id
        ) {
          calls.push(node);
        }
      });
      const call = unique(calls, entry);
      if (call === undefined) {
        return panic(`Dated test quarantine call missing: ${entry.id}`);
      }
      return { expiresAt: match.expiresAt, call: semanticTree(ast, call) };
    }
    case "guard-rollout": {
      // One rollout per JSON file; the parsed file is the entry.
      const parsed: unknown = Result.try(() => JSON.parse(source)).unwrapOr(
        undefined,
      );
      if (typeof parsed !== "object" || parsed === null || !("id" in parsed)) {
        return panic(`Invalid guard rollout: ${entry.source}`);
      }
      return parsed.id === entry.id ? parsed : undefined;
    }
    case "pending-contract-migration":
      return objectEntry(entry, source);
    default:
      entry.kind satisfies never;
      return panic("Unknown dated waiver kind");
  }
};
