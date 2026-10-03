import { panic } from "better-result";
import ts from "typescript";

import { parseSource } from "./parse-memo.ts";

export type StatusColumns = Readonly<Record<string, readonly string[]>>;

const unwrap = (expression: ts.Expression): ts.Expression => {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrap(expression.expression);
  }
  return expression;
};

const propertyName = (name: ts.PropertyName): string | undefined => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (
    ts.isComputedPropertyName(name) &&
    ts.isStringLiteralLike(name.expression)
  ) {
    return name.expression.text;
  }
  return undefined;
};

const methodName = (expression: ts.Expression): string | undefined => {
  const member = unwrap(expression);
  if (ts.isPropertyAccessExpression(member)) {
    return member.name.text;
  }
  if (
    ts.isElementAccessExpression(member) &&
    ts.isStringLiteralLike(member.argumentExpression)
  ) {
    return member.argumentExpression.text;
  }
  return undefined;
};

const receiver = (expression: ts.Expression): ts.Expression | undefined => {
  const member = unwrap(expression);
  return ts.isPropertyAccessExpression(member) ||
    ts.isElementAccessExpression(member)
    ? member.expression
    : undefined;
};

type Binding =
  | { type: "import"; source: string; name: string }
  | { type: "value"; expression: ts.Expression }
  | { type: "shadow" };

const isScope = (node: ts.Node): boolean =>
  ts.isSourceFile(node) ||
  ts.isBlock(node) ||
  ts.isFunctionLike(node) ||
  ts.isForStatement(node) ||
  ts.isForOfStatement(node) ||
  ts.isForInStatement(node) ||
  ts.isCatchClause(node);

const bindingsFor = (source: ts.SourceFile) => {
  const scopes = new Map<ts.Node, Map<string, Binding>>();
  const scopeOf = (node: ts.Node): ts.Node => {
    let scope = node;
    while (!isScope(scope) && scope.parent !== undefined) {
      scope = scope.parent;
    }
    return scope;
  };
  const declare = (node: ts.Node, name: ts.BindingName, binding: Binding) => {
    if (!ts.isIdentifier(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) {
          declare(node, element.name, { type: "shadow" });
        }
      }
      return;
    }
    const scope = scopeOf(node);
    const entries = scopes.get(scope) ?? new Map<string, Binding>();
    entries.set(name.text, binding);
    scopes.set(scope, entries);
  };
  const collect = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const importSource = node.moduleSpecifier.text;
      const named = node.importClause?.namedBindings;
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const item of named.elements) {
          declare(node, item.name, {
            type: "import",
            source: importSource,
            name: (item.propertyName ?? item.name).text,
          });
        }
      } else if (named !== undefined) {
        declare(node, named.name, {
          type: "import",
          source: importSource,
          name: "*",
        });
      }
    }
    if (ts.isVariableDeclaration(node)) {
      declare(
        node.parent,
        node.name,
        node.initializer === undefined
          ? { type: "shadow" }
          : { type: "value", expression: node.initializer },
      );
    }
    if (ts.isParameter(node)) {
      declare(node.parent, node.name, { type: "shadow" });
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  return (name: string, node: ts.Node): Binding | undefined => {
    let current: ts.Node | undefined = node;
    while (current !== undefined) {
      const binding = scopes.get(current)?.get(name);
      if (binding !== undefined) {
        return binding;
      }
      current = current.parent;
    }
    return undefined;
  };
};

const isSchema = (source: string): boolean =>
  /(?:^|\/)(?:db\/)?(?:auth-)?schema(?:\/|$)/u.test(
    source.replace(/\.[cm]?[jt]s$/u, ""),
  );

type StatusWriteOptions = {
  content: string;
  file: string;
  columns: StatusColumns;
};

// Syntax boundary: follows schema import/const aliases, fluent update chains,
// and literal or const-object payloads (including spreads). Dynamic payloads
// cannot be classified without type information.
export const statusWriteCalls = ({
  content,
  file,
  columns,
}: StatusWriteOptions): ts.CallExpression[] => {
  const source = parseSource({ text: content, fileName: file });
  const bindingFor = bindingsFor(source);
  const literalKey = (
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string | undefined => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (ts.isStringLiteralLike(value)) {
      return value.text;
    }
    if (!ts.isIdentifier(value)) {
      return undefined;
    }
    const binding = bindingFor(value.text, value);
    return binding?.type === "value"
      ? literalKey(binding.expression, seen)
      : undefined;
  };
  const payloadKey = (name: ts.PropertyName): string | undefined =>
    ts.isComputedPropertyName(name)
      ? literalKey(name.expression)
      : propertyName(name);
  const tableOf = (
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): string | undefined => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (ts.isIdentifier(value)) {
      const binding = bindingFor(value.text, value);
      if (binding === undefined) {
        return Object.hasOwn(columns, value.text) ? value.text : undefined;
      }
      if (binding.type === "value") {
        return tableOf(binding.expression, seen);
      }
      return binding.type === "import" &&
        isSchema(binding.source) &&
        Object.hasOwn(columns, binding.name)
        ? binding.name
        : undefined;
    }
    if (
      (ts.isPropertyAccessExpression(value) ||
        ts.isElementAccessExpression(value)) &&
      ts.isIdentifier(value.expression)
    ) {
      const binding = bindingFor(value.expression.text, value.expression);
      const name = methodName(value);
      return binding?.type === "import" &&
        binding.name === "*" &&
        isSchema(binding.source) &&
        name !== undefined &&
        Object.hasOwn(columns, name)
        ? name
        : undefined;
    }
    return undefined;
  };
  const updatedTable = (expression: ts.Expression): string | undefined => {
    const value = unwrap(expression);
    if (!ts.isCallExpression(value)) {
      return undefined;
    }
    const argument = value.arguments.at(0);
    if (methodName(value.expression) === "update" && argument !== undefined) {
      return tableOf(argument);
    }
    const target = receiver(value.expression);
    return target === undefined ? undefined : updatedTable(target);
  };
  const containsStatus = (
    expression: ts.Expression,
    keys: readonly string[],
    seen = new Set<ts.Node>(),
  ): boolean => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return false;
    }
    seen.add(value);
    if (ts.isIdentifier(value)) {
      const binding = bindingFor(value.text, value);
      return (
        binding?.type === "value" &&
        containsStatus(binding.expression, keys, seen)
      );
    }
    if (!ts.isObjectLiteralExpression(value)) {
      return false;
    }
    return value.properties.some((property) =>
      ts.isSpreadAssignment(property)
        ? containsStatus(property.expression, keys, seen)
        : property.name !== undefined &&
          keys.includes(payloadKey(property.name) ?? ""),
    );
  };
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && methodName(node.expression) === "set") {
      const target = receiver(node.expression);
      const table = target === undefined ? undefined : updatedTable(target);
      const payload = node.arguments.at(0);
      const keys = table === undefined ? undefined : columns[table];
      if (
        keys !== undefined &&
        payload !== undefined &&
        containsStatus(payload, keys)
      ) {
        matches.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return matches;
};

export const unmanagedTransitionTables = (
  content: string,
): readonly string[] => {
  const source = parseSource({
    text: content,
    fileName: "transition-specs.ts",
  });
  const bindingFor = bindingsFor(source);
  const objectOf = (
    expression: ts.Expression,
    seen = new Set<ts.Node>(),
  ): ts.ObjectLiteralExpression | undefined => {
    const value = unwrap(expression);
    if (seen.has(value)) {
      return undefined;
    }
    seen.add(value);
    if (ts.isObjectLiteralExpression(value)) {
      return value;
    }
    if (!ts.isIdentifier(value)) {
      return undefined;
    }
    const binding = bindingFor(value.text, value);
    return binding?.type === "value"
      ? objectOf(binding.expression, seen)
      : undefined;
  };
  const hasUnmanaged = (
    object: ts.ObjectLiteralExpression,
    seen = new Set<ts.Node>(),
  ): boolean => {
    if (seen.has(object)) {
      return false;
    }
    seen.add(object);
    return object.properties.some((property) => {
      if (!ts.isSpreadAssignment(property)) {
        return (
          property.name !== undefined &&
          propertyName(property.name) === "unmanaged"
        );
      }
      const spread = objectOf(property.expression);
      return spread !== undefined && hasUnmanaged(spread, seen);
    });
  };
  let declarations: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "TRANSITIONS" &&
      node.initializer !== undefined
    ) {
      declarations = objectOf(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (declarations === undefined) {
    return panic(
      "Transition specs require a statically readable TRANSITIONS object",
    );
  }
  const unmanaged = new Set<string>();
  const collect = (
    object: ts.ObjectLiteralExpression,
    seen = new Set<ts.Node>(),
  ) => {
    if (seen.has(object)) {
      return;
    }
    seen.add(object);
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        const spread = objectOf(property.expression);
        if (spread === undefined) {
          panic("Transition spec spreads must be statically readable");
        }
        collect(spread, seen);
        continue;
      }
      if (
        !ts.isPropertyAssignment(property) &&
        !ts.isShorthandPropertyAssignment(property)
      ) {
        panic("Transition spec entries must be properties");
      }
      const name = propertyName(property.name);
      if (name === undefined) {
        panic("Transition spec table keys must be static");
      }
      const value = objectOf(
        ts.isPropertyAssignment(property)
          ? property.initializer
          : property.name,
      );
      if (value !== undefined && hasUnmanaged(value)) {
        unmanaged.add(name);
      }
    }
  };
  collect(declarations);
  return [...unmanaged].toSorted();
};

export const countUnmanagedTransitionSpecs = (content: string): number =>
  unmanagedTransitionTables(content).length;
