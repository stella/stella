import type { Reference, Variable } from "@oxlint/plugins";

import {
  getPropertyName,
  isAstNode,
  isIdentifierReference,
  memberPropertyName,
  type ImportedBinding,
  resolveImport,
  resolveImportedExpressionForEnforcement,
  resolveVariable,
  staticStringValue,
  type ScopeContext,
  unwrapExpression,
} from "./utils.ts";

const memberPath = ({ base, property }: { base: string; property: string }) => {
  if (base === "globalThis") {
    return property === "globalThis" ||
      property === "window" ||
      property === "self"
      ? "globalThis"
      : property;
  }
  return base === "perf_hooks" && property === "performance"
    ? "performance"
    : `${base}.${property}`;
};

const GLOBAL_CLOCKS = new Set([
  "Date",
  "performance",
  "Temporal",
  "globalThis",
  "setTimeout",
  "setInterval",
  "Bun",
  "window",
  "self",
]);

type BindingSelector = string | Reference["identifier"];

const bindingProperties = (binding: BindingSelector) => {
  const propertiesForBinding = (
    pattern: unknown,
    properties: string[] = [],
  ): string[] | null => {
    if (!isAstNode(pattern)) {
      return null;
    }
    if (isIdentifierReference(pattern) || pattern.type === "Identifier") {
      const matches =
        typeof binding === "string"
          ? pattern.name === binding
          : pattern === binding;
      return matches ? properties : null;
    }
    if (pattern.type === "AssignmentPattern") {
      return propertiesForBinding(pattern.left, properties);
    }
    if (
      pattern.type !== "ObjectPattern" ||
      !Array.isArray(pattern.properties)
    ) {
      return null;
    }
    for (const property of pattern.properties) {
      if (!isAstNode(property) || property.type !== "Property") {
        continue;
      }
      const name =
        property.computed === true
          ? staticStringValue(property.key)
          : getPropertyName(property.key);
      if (name === null) {
        continue;
      }
      const found = propertiesForBinding(property.value, [...properties, name]);
      if (found !== null) {
        return found;
      }
    }
    return null;
  };
  return propertiesForBinding;
};

const assignmentPatternForWrite = (reference: Reference): unknown => {
  let child: unknown = reference.identifier;
  let parent: unknown = reference.identifier.parent;
  while (isAstNode(parent)) {
    if (parent.type === "AssignmentExpression") {
      return parent.left === child && parent.right === reference.writeExpr
        ? parent.left
        : reference.identifier;
    }
    child = parent;
    parent = parent.parent;
  }
  return reference.identifier;
};

type TimeResolverOptions = {
  additionalGlobals?: ReadonlySet<string>;
  importedPaths?: (binding: ImportedBinding) => readonly string[];
};

export const createTimeResolver = (
  context: ScopeContext,
  {
    additionalGlobals = new Set(),
    importedPaths = () => [],
  }: TimeResolverOptions = {},
) => {
  const importedClockPaths = (node: unknown): string[] => {
    const binding = resolveImportedExpressionForEnforcement(context, node);
    if (binding !== null) {
      const imported = importedPaths(binding);
      if (imported.length > 0) {
        return [...imported];
      }
    }
    const imported = resolveImport(context, node);
    if (
      imported?.moduleId === "node:perf_hooks" ||
      imported?.moduleId === "perf_hooks"
    ) {
      if (imported.imported === "performance") {
        return ["performance"];
      }
      if (imported.imported === "*" || imported.imported === "default") {
        return ["perf_hooks"];
      }
    }
    return [];
  };

  const paths = (input: unknown, seen = new Set<Variable>()): string[] => {
    const node = unwrapExpression(input);
    if (node === null) {
      return [];
    }
    const imported = importedClockPaths(node);
    if (imported.length > 0) {
      return imported;
    }
    if (node.type === "CallExpression") {
      const callee = unwrapExpression(node.callee);
      return callee?.type === "MemberExpression" &&
        memberPropertyName(callee) === "bind"
        ? paths(callee.object, seen).filter(
            (path) =>
              path !== "Date" ||
              !Array.isArray(node.arguments) ||
              node.arguments.length <= 1,
          )
        : [];
    }
    if (node.type === "MemberExpression") {
      const property = memberPropertyName(node);
      if (property === null) {
        return [];
      }
      return paths(node.object, seen).map((base) =>
        memberPath({ base, property }),
      );
    }
    if (!isIdentifierReference(node)) {
      return [];
    }
    const variable = resolveVariable(context, node);
    if (variable === null || variable.defs.length === 0) {
      if (node.name === "window" || node.name === "self") {
        return ["globalThis"];
      }
      return GLOBAL_CLOCKS.has(node.name) || additionalGlobals.has(node.name)
        ? [node.name]
        : [];
    }
    if (seen.has(variable)) {
      return [];
    }
    const nextSeen = new Set(seen).add(variable);
    const result: string[] = [];
    type AppendPathsOptions = {
      pattern: unknown;
      source: unknown;
      binding: BindingSelector;
    };
    const appendPaths = ({ pattern, source, binding }: AppendPathsOptions) => {
      const properties = bindingProperties(binding)(pattern);
      if (properties === null) {
        return;
      }
      for (const base of paths(source, nextSeen)) {
        let resolved = base;
        for (const property of properties) {
          resolved = memberPath({ base: resolved, property });
        }
        result.push(resolved);
      }
    };
    for (const definition of variable.defs) {
      if (definition.node.type !== "VariableDeclarator") {
        continue;
      }
      const { id, init } = definition.node;
      appendPaths({ pattern: id, source: init, binding: node.name });
    }
    for (const reference of variable.references) {
      if (reference.isWrite() && !reference.init) {
        appendPaths({
          pattern: assignmentPatternForWrite(reference),
          source: reference.writeExpr,
          binding: reference.identifier,
        });
      }
    }
    return result;
  };

  const isAmbientRead = (input: unknown): boolean => {
    const node = unwrapExpression(input);
    if (node?.type !== "CallExpression" && node?.type !== "NewExpression") {
      return false;
    }
    return callablePaths(node.callee).some((clock) => {
      if (node.type === "NewExpression") {
        return (
          clock === "Date" &&
          Array.isArray(node.arguments) &&
          node.arguments.length === 0
        );
      }
      return (
        clock === "Date.now" ||
        clock === "performance.now" ||
        /^Temporal\.Now\.[^.]+$/u.test(clock)
      );
    });
  };

  const callablePaths = (input: unknown) =>
    paths(input).map((path) => path.replace(/\.(?:call|apply)$/u, ""));

  return { isAmbientRead, globalPaths: paths, callablePaths };
};
