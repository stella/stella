import { walk } from "@stll/scripts/src/syntax-tree";
import type { Node, Program } from "@stll/scripts/src/syntax-tree";

/** An identifier in one of these places names a property or a label. */
const isNameOnly = (node: Node, parent: Node | undefined): boolean => {
  if (parent === undefined) {
    return false;
  }
  if (parent.type === "MemberExpression") {
    return parent.property === node && !parent.computed;
  }
  if (parent.type === "Property") {
    return parent.key === node && !parent.computed && !parent.shorthand;
  }
  if (
    parent.type === "MethodDefinition" ||
    parent.type === "PropertyDefinition" ||
    parent.type === "AccessorProperty"
  ) {
    return parent.key === node && !parent.computed;
  }
  return (
    parent.type === "LabeledStatement" ||
    parent.type === "BreakStatement" ||
    parent.type === "ContinueStatement" ||
    parent.type === "MetaProperty"
  );
};

const patternNames = (pattern: Node | null): string[] => {
  if (pattern === null) {
    return [];
  }
  if (pattern.type === "Identifier") {
    return [pattern.name];
  }
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.flatMap((property) =>
      patternNames(
        property.type === "RestElement" ? property.argument : property.value,
      ),
    );
  }
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => patternNames(element));
  }
  if (pattern.type === "RestElement") {
    return patternNames(pattern.argument);
  }
  if (pattern.type === "AssignmentPattern") {
    return patternNames(pattern.left);
  }
  return [];
};

const isFunction = (node: Node) =>
  node.type === "FunctionDeclaration" ||
  node.type === "FunctionExpression" ||
  node.type === "ArrowFunctionExpression";

/** `let`, `const`, class and function declarations of a block. */
const lexicalNames = (statements: readonly Node[]): string[] =>
  statements.flatMap((statement) => {
    if (statement.type === "VariableDeclaration" && statement.kind !== "var") {
      return statement.declarations.flatMap(({ id }) => patternNames(id));
    }
    if (
      (statement.type === "FunctionDeclaration" ||
        statement.type === "ClassDeclaration") &&
      statement.id !== null
    ) {
      return [statement.id.name];
    }
    return [];
  });

const varNamesByBody = new WeakMap<Node, readonly string[]>();
/** `var` declarations of a function body, nested functions excluded. */
const varNames = (body: Node): readonly string[] => {
  const known = varNamesByBody.get(body);
  if (known !== undefined) {
    return known;
  }
  const names: string[] = [];
  walk(body, (node) => {
    if (node !== body && isFunction(node)) {
      return "skip-children";
    }
    if (node.type === "VariableDeclaration" && node.kind === "var") {
      names.push(...node.declarations.flatMap(({ id }) => patternNames(id)));
    }
    return undefined;
  });
  varNamesByBody.set(body, names);
  return names;
};

/**
 * Names a node declares for its descendant `child`: a function's parameters
 * reach its whole subtree, its `var` declarations only its body.
 */
const declaredNames = (node: Node, child: Node): readonly string[] => {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return [
      ...node.params.flatMap((parameter) => patternNames(parameter)),
      ...(node.type === "FunctionExpression" && node.id !== null
        ? [node.id.name]
        : []),
      ...(node.body !== null && child === node.body ? varNames(node.body) : []),
    ];
  }
  if (node.type === "BlockStatement" || node.type === "StaticBlock") {
    return lexicalNames(node.body);
  }
  if (node.type === "SwitchStatement") {
    return lexicalNames(node.cases.flatMap(({ consequent }) => consequent));
  }
  if (node.type === "ForStatement") {
    return node.init?.type === "VariableDeclaration"
      ? node.init.declarations.flatMap(({ id }) => patternNames(id))
      : [];
  }
  if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
    return node.left.type === "VariableDeclaration"
      ? node.left.declarations.flatMap(({ id }) => patternNames(id))
      : [];
  }
  if (node.type === "CatchClause") {
    return patternNames(node.param);
  }
  if (node.type === "ClassExpression") {
    return node.id === null ? [] : [node.id.name];
  }
  return [];
};

/** The member `node.name` or `node["name"]` reads, if its parent is one. */
const memberRead = (
  node: Node,
  parent: Node | undefined,
): string | undefined => {
  if (parent?.type !== "MemberExpression" || parent.object !== node) {
    return undefined;
  }
  const { computed, property } = parent;
  if (!computed) {
    return property.type === "Identifier" ? property.name : undefined;
  }
  return property.type === "Literal" && typeof property.value === "string"
    ? property.value
    : undefined;
};

/**
 * The members a module reads from each of its namespace imports, by local
 * name, or none for a namespace it uses in any other way: passed on,
 * spread, or read with a key that is not a string literal. An identifier
 * that a function, block or catch clause around it declares names that
 * binding, not the import.
 */
export const namespaceMembers = (
  program: Program,
  locals: ReadonlySet<string>,
): Map<string, Set<string> | undefined> => {
  const members = new Map<string, Set<string> | undefined>(
    [...locals].map((local) => [local, new Set()]),
  );
  walk(program, (node, ancestors) => {
    if (node.type === "ImportDeclaration") {
      return "skip-children";
    }
    if (node.type !== "Identifier" || !locals.has(node.name)) {
      return undefined;
    }
    const parent = ancestors.at(-1);
    const shadowed = ancestors.some((ancestor, index) =>
      declaredNames(ancestor, ancestors[index + 1] ?? node).includes(node.name),
    );
    if (shadowed || isNameOnly(node, parent)) {
      return undefined;
    }
    const read = memberRead(node, parent);
    if (read === undefined) {
      members.set(node.name, undefined);
    } else {
      members.get(node.name)?.add(read);
    }
    return undefined;
  });
  return members;
};
