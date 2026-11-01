// Direct calls to one imported function, resolved through lexical bindings.
// Ownership censuses use it to prove that a narrowly owned export is only ever
// called, never passed around, re-exported or loaded indirectly.

import { panic } from "better-result";

import {
  type BindingIdentifier as Identifier,
  type BindingPattern,
  type BindingRestElement,
  type Expression,
  type FormalParameterRest,
  type MemberExpression,
  type Node,
  parseSource,
  type Statement,
  staticPropertyName,
  walk,
} from "../packages/scripts/src/syntax-tree";

const stringValue = (node: Node | undefined): string | undefined => {
  if (node?.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.at(0)?.value.cooked ?? undefined;
  }
  return undefined;
};

const bindingIdentifiers = (
  name: BindingPattern | BindingRestElement | FormalParameterRest,
): Identifier[] => {
  switch (name.type) {
    case "Identifier":
      return [name];
    case "AssignmentPattern":
      return bindingIdentifiers(name.left);
    case "RestElement":
      return bindingIdentifiers(name.argument);
    case "ArrayPattern":
      return name.elements.flatMap((element) =>
        element === null ? [] : bindingIdentifiers(element),
      );
    case "ObjectPattern":
      return name.properties.flatMap((property) =>
        bindingIdentifiers(
          property.type === "RestElement" ? property.argument : property.value,
        ),
      );
    default:
      name satisfies never;
      return panic("Unknown binding pattern");
  }
};

const statementDeclarations = function* (
  statements: readonly (Statement | Directive)[],
): Generator<Identifier> {
  for (let statement of statements) {
    if (
      statement.type === "ExportNamedDeclaration" &&
      statement.declaration !== null
    ) {
      statement = statement.declaration;
    }
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        yield* bindingIdentifiers(declaration.id);
      }
    } else if (
      (statement.type === "FunctionDeclaration" ||
        statement.type === "ClassDeclaration") &&
      statement.id !== null
    ) {
      yield statement.id;
    } else if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        yield specifier.local;
      }
    }
  }
};

const scopeDeclarations = function* (scope: Node): Generator<Identifier> {
  if (
    scope.type === "FunctionDeclaration" ||
    scope.type === "FunctionExpression" ||
    scope.type === "ArrowFunctionExpression" ||
    scope.type === "TSDeclareFunction"
  ) {
    for (const parameter of scope.params) {
      yield* bindingIdentifiers(
        parameter.type === "TSParameterProperty"
          ? parameter.parameter
          : parameter,
      );
    }
    if (scope.type === "FunctionExpression" && scope.id !== null) {
      yield scope.id;
    }
    return;
  }
  if (
    scope.type === "Program" ||
    scope.type === "BlockStatement" ||
    scope.type === "TSModuleBlock"
  ) {
    yield* statementDeclarations(scope.body);
    return;
  }
  if (scope.type === "SwitchStatement") {
    for (const clause of scope.cases) {
      yield* statementDeclarations(clause.consequent);
    }
    return;
  }
  if (scope.type === "CatchClause" && scope.param !== null) {
    yield* bindingIdentifiers(scope.param);
    return;
  }
  let initializer;
  if (scope.type === "ForStatement") {
    initializer = scope.init;
  } else if (
    scope.type === "ForOfStatement" ||
    scope.type === "ForInStatement"
  ) {
    initializer = scope.left;
  }
  if (initializer?.type === "VariableDeclaration") {
    for (const declaration of initializer.declarations) {
      yield* bindingIdentifiers(declaration.id);
    }
  }
};

function unwrapTypes(node: Expression): Expression;
function unwrapTypes(node: Node): Node;
function unwrapTypes(node: Node): Node {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "ChainExpression"
  ) {
    current = current.expression;
  }
  return current;
}
/** Type wrappers and awaits removed; a non-expression node is returned as is. */
function unwrap(node: Expression): Expression;
function unwrap(node: Node): Node;
function unwrap(node: Node): Node {
  let current = unwrapTypes(node);
  while (current.type === "AwaitExpression") {
    current = unwrapTypes(current.argument);
  }
  return current;
}

type ParentMap = ReadonlyMap<Node, Node>;
const scopeDeclarationIndexes = new WeakMap<
  ParentMap,
  WeakMap<Node, ReadonlyMap<string, Identifier>>
>();

const scopeDeclaration = ({
  scope,
  name,
  parents,
}: {
  scope: Node;
  name: string;
  parents: ParentMap;
}): Identifier | undefined => {
  let scopes = scopeDeclarationIndexes.get(parents);
  if (scopes === undefined) {
    scopes = new WeakMap();
    scopeDeclarationIndexes.set(parents, scopes);
  }
  let declarations = scopes.get(scope);
  if (declarations === undefined) {
    const indexed = new Map<string, Identifier>();
    for (const binding of scopeDeclarations(scope)) {
      // Preserve the resolver's existing first-declaration precedence.
      if (!indexed.has(binding.name)) {
        indexed.set(binding.name, binding);
      }
    }
    declarations = indexed;
    scopes.set(scope, declarations);
  }
  return declarations.get(name);
};

const resolveDeclaration = (
  reference: Identifier,
  parents: ParentMap,
): Identifier | undefined => {
  for (
    let scope = parents.get(reference);
    scope !== undefined;
    scope = parents.get(scope)
  ) {
    const declared = scopeDeclaration({ scope, name: reference.name, parents });
    if (declared !== undefined) {
      return declared;
    }
  }
  return undefined;
};
const isReferencePosition = (
  identifier: Identifier,
  parents: ParentMap,
): boolean => {
  const parent = parents.get(identifier);
  if (
    parent?.type === "MemberExpression" &&
    !parent.computed &&
    parent.property === identifier
  ) {
    return false;
  }
  if (
    parent?.type === "ImportSpecifier" &&
    parent.imported === identifier &&
    parent.local !== identifier
  ) {
    return false;
  }
  if (
    parent?.type === "Property" &&
    !parent.shorthand &&
    parent.key === identifier
  ) {
    return false;
  }
  return true;
};
const accessName = (access: MemberExpression): string | undefined =>
  !access.computed && access.property.type === "Identifier"
    ? access.property.name
    : stringValue(access.property);

type ImportedValue = { type: "member"; name: string } | { type: "namespace" };
type ModulePattern = RegExp | ((specifier: string) => boolean);

const matchesModule = (
  specifier: string,
  modulePattern: ModulePattern,
): boolean =>
  modulePattern instanceof RegExp
    ? modulePattern.test(specifier)
    : modulePattern(specifier);

const isDynamicModuleImport = (
  expression: Expression,
  modulePattern: ModulePattern,
): boolean => {
  const value = unwrap(expression);
  const source =
    value.type === "ImportExpression" ? stringValue(value.source) : undefined;
  return source !== undefined && matchesModule(source, modulePattern);
};

/** A runtime named or namespace import from a matching module. */
const importSpecifierValue = (
  specifier: Extract<
    Node,
    { type: "ImportSpecifier" | "ImportNamespaceSpecifier" }
  >,
  modulePattern: ModulePattern,
  parents: ParentMap,
): ImportedValue | undefined => {
  const imported = parents.get(specifier);
  if (
    imported?.type !== "ImportDeclaration" ||
    imported.importKind === "type" ||
    !matchesModule(stringValue(imported.source) ?? "", modulePattern) ||
    stringValue(imported.source) === undefined
  ) {
    return undefined;
  }
  if (specifier.type === "ImportNamespaceSpecifier") {
    return { type: "namespace" };
  }
  if (specifier.importKind === "type") {
    return undefined;
  }
  return {
    type: "member",
    name:
      specifier.imported.type === "Identifier"
        ? specifier.imported.name
        : specifier.imported.value,
  };
};

/** A member destructured from a literal dynamic import of a matching module. */
const destructuredImportValue = (
  property: Extract<Node, { type: "Property" }>,
  modulePattern: ModulePattern,
  parents: ParentMap,
): ImportedValue | undefined => {
  const pattern = parents.get(property);
  const variable = pattern && parents.get(pattern);
  const name = property.computed ? undefined : staticPropertyName(property);
  return pattern?.type === "ObjectPattern" &&
    variable?.type === "VariableDeclarator" &&
    variable.init !== null &&
    isDynamicModuleImport(variable.init, modulePattern) &&
    name !== undefined
    ? { type: "member", name }
    : undefined;
};

// Resolve imports and immutable aliases using the same lexical declarations
// as the owner-handle scanner. Mutable aliases never establish admission.
const importedValue = (
  expression: Expression | Extract<Node, { type: "Identifier" }>,
  modulePattern: ModulePattern,
  parents: ParentMap,
  seen = new Set<Identifier>(),
): ImportedValue | undefined => {
  const value =
    expression.type === "Identifier" ? expression : unwrap(expression);
  if (value.type === "MemberExpression") {
    const name = accessName(value);
    return name !== undefined &&
      importedValue(value.object, modulePattern, parents, seen)?.type ===
        "namespace"
      ? { type: "member", name }
      : undefined;
  }
  if (value.type !== "Identifier") {
    return undefined;
  }
  const declaration = resolveDeclaration(value, parents);
  if (declaration === undefined || seen.has(declaration)) {
    return undefined;
  }
  seen.add(declaration);
  const parent = parents.get(declaration);
  if (
    parent?.type === "ImportSpecifier" ||
    parent?.type === "ImportNamespaceSpecifier"
  ) {
    return importSpecifierValue(parent, modulePattern, parents);
  }
  const property =
    parent?.type === "AssignmentPattern" ? parents.get(parent) : parent;
  if (property?.type === "Property") {
    return destructuredImportValue(property, modulePattern, parents);
  }
  if (parent?.type !== "VariableDeclarator" || parent.init === null) {
    return undefined;
  }
  const declarations = parents.get(parent);
  if (
    declarations?.type !== "VariableDeclaration" ||
    declarations.kind !== "const"
  ) {
    return undefined;
  }
  return isDynamicModuleImport(parent.init, modulePattern)
    ? { type: "namespace" }
    : importedValue(parent.init, modulePattern, parents, seen);
};

export type ImportedCallSite = {
  readonly line: number;
  readonly arguments: readonly Node[];
};

export type ImportedCallInventory = {
  readonly imported: boolean;
  readonly calls: readonly ImportedCallSite[];
};

const mayReferenceRuntimeRequire = (content: string): boolean => {
  if (/\brequire\b/u.test(content)) {
    return true;
  }
  if (!content.includes("\\u")) {
    return false;
  }
  const decoded = content.replace(
    /\\u(?:\{[\da-fA-F]+\}|[\da-fA-F]{4})/gu,
    (escape) => {
      const hex = escape.startsWith("\\u{")
        ? escape.slice(3, -1)
        : escape.slice(2);
      const codePoint = Number.parseInt(hex, 16);
      // Comments and raw text may contain out-of-range escape-shaped content.
      return codePoint <= 0x10_ff_ff ? String.fromCodePoint(codePoint) : escape;
    },
  );
  return /\brequire\b/u.test(decoded);
};

/** Resolve direct calls to one imported function through lexical bindings. */
const referencesImportedModule = (
  source: ReturnType<typeof parseSource>,
  modulePattern: ModulePattern,
): boolean => {
  const staticSpecifiers = [
    ...source.module.staticImports.map(
      ({ moduleRequest }) => moduleRequest.value,
    ),
    ...source.module.staticExports.flatMap(({ entries }) =>
      entries.flatMap(({ moduleRequest }) =>
        moduleRequest === null ? [] : [moduleRequest.value],
      ),
    ),
  ];
  let referencesModule = staticSpecifiers.some((specifier) =>
    matchesModule(specifier, modulePattern),
  );
  // Parsing and native module records still cover every file. Only dynamic
  // imports or a possible decoded require token need AST materialization.
  const mayHaveNonStaticImport =
    source.module.dynamicImports.length > 0 ||
    mayReferenceRuntimeRequire(source.sourceText);
  if (!referencesModule && mayHaveNonStaticImport) {
    walk(source.program, (node) => {
      if (referencesModule) {
        return "skip-children";
      }
      let specifier: string | undefined;
      if (node.type === "ImportExpression") {
        specifier = stringValue(node.source);
      }
      if (
        node.type === "CallExpression" &&
        node.callee.type === "Identifier" &&
        node.callee.name === "require"
      ) {
        specifier = stringValue(node.arguments.at(0));
      }
      if (
        node.type === "TSImportEqualsDeclaration" &&
        node.moduleReference.type === "TSExternalModuleReference"
      ) {
        specifier = stringValue(node.moduleReference.expression);
      }
      if (specifier !== undefined && matchesModule(specifier, modulePattern)) {
        referencesModule = true;
      }
      return undefined;
    });
  }
  return referencesModule;
};

type ModuleUseOptions = {
  readonly node: Node;
  readonly file: string;
  readonly exportName: string;
  readonly modulePattern: ModulePattern;
};

/** Whether a runtime import declaration names the module's owned export. */
const inspectImportDeclaration = ({
  node,
  file,
  exportName,
  modulePattern,
}: ModuleUseOptions): boolean => {
  const importSpecifier =
    node.type === "ImportDeclaration" ? stringValue(node.source) : undefined;
  if (
    node.type !== "ImportDeclaration" ||
    importSpecifier === undefined ||
    !matchesModule(importSpecifier, modulePattern) ||
    node.importKind === "type"
  ) {
    return false;
  }
  const runtimeSpecifiers = node.specifiers.filter(
    (specifier) =>
      specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
  );
  for (const specifier of runtimeSpecifiers) {
    if (
      specifier.type === "ImportSpecifier" &&
      (specifier.imported.type === "Identifier"
        ? specifier.imported.name
        : specifier.imported.value) !== exportName
    ) {
      panic(`${file} imports an unowned export from ${importSpecifier}`);
    }
    if (specifier.type === "ImportDefaultSpecifier") {
      panic(`${file} must use a named or namespace import for ${exportName}`);
    }
  }
  return node.specifiers.length === 0 || runtimeSpecifiers.length > 0;
};

/**
 * Whether the node imports the module at run time. Every indirect form (a
 * re-export, a dynamic import, import-equals or `require`) is refused.
 */
const inspectModuleUse = (options: ModuleUseOptions): boolean => {
  const { node, file, exportName, modulePattern } = options;
  const matches = (specifier: string | undefined) =>
    matchesModule(specifier ?? "", modulePattern);
  if (
    (node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration") &&
    node.source !== null &&
    matches(stringValue(node.source))
  ) {
    panic(`${file} cannot re-export ${exportName}`);
  }
  if (node.type === "ImportExpression" && matches(stringValue(node.source))) {
    panic(`${file} cannot dynamically import ${exportName}`);
  }
  if (
    node.type === "TSImportEqualsDeclaration" &&
    node.moduleReference.type === "TSExternalModuleReference" &&
    matches(stringValue(node.moduleReference.expression))
  ) {
    panic(`${file} cannot use import-equals for ${exportName}`);
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    matches(stringValue(node.arguments.at(0)))
  ) {
    panic(`${file} cannot require ${exportName}`);
  }
  return inspectImportDeclaration(options);
};

export const findImportedFunctionCalls = ({
  content,
  exportName,
  file,
  modulePattern,
}: {
  readonly content: string;
  readonly exportName: string;
  readonly file: string;
  readonly modulePattern: ModulePattern;
}): ImportedCallInventory => {
  const source = parseSource(file, content);
  if (!referencesImportedModule(source, modulePattern)) {
    return { imported: false, calls: [] };
  }
  const parents = new Map<Node, Node>();
  walk(source.program, (node, ancestors) => {
    const parent = ancestors.at(-1);
    if (parent !== undefined) {
      parents.set(node, parent);
    }
  });

  let imported = false;
  const calls: ImportedCallSite[] = [];
  const canBeDirectCallOrConstAlias = (expression: Node): boolean => {
    let current = expression;
    for (;;) {
      const parent = parents.get(current);
      if (
        parent?.type === "ParenthesizedExpression" ||
        parent?.type === "TSAsExpression" ||
        parent?.type === "TSSatisfiesExpression" ||
        parent?.type === "TSNonNullExpression" ||
        parent?.type === "TSTypeAssertion"
      ) {
        current = parent;
        continue;
      }
      if (parent?.type === "CallExpression" && parent.callee === current) {
        return true;
      }
      if (
        parent?.type === "VariableDeclarator" &&
        parent.init === current &&
        parent.id.type === "Identifier"
      ) {
        const declaration = parents.get(parent);
        return (
          declaration?.type === "VariableDeclaration" &&
          declaration.kind === "const"
        );
      }
      return false;
    }
  };
  walk(source.program, (node) => {
    imported ||= inspectModuleUse({ node, file, exportName, modulePattern });
    if (node.type !== "CallExpression") {
      return;
    }
    const callee = importedValue(node.callee, modulePattern, parents);
    if (callee?.type === "member" && callee.name === exportName) {
      calls.push({
        line: source.locate(node.start).line,
        arguments: node.arguments,
      });
    }
  });

  // Every runtime use must stay a direct call or an immutable const alias
  // whose own uses pass this same check. Counting calls alone would let one
  // valid call mask an escaped function reference in the same module.
  walk(source.program, (node) => {
    if (node.type === "MemberExpression") {
      const importedMember = importedValue(node, modulePattern, parents);
      if (
        importedMember?.type === "member" &&
        importedMember.name === exportName &&
        !canBeDirectCallOrConstAlias(node)
      ) {
        panic(
          `${file} must use ${exportName} only as a direct call or const alias`,
        );
      }
      return;
    }
    if (
      node.type !== "Identifier" ||
      !isReferencePosition(node, parents) ||
      resolveDeclaration(node, parents) === node
    ) {
      return;
    }
    const importedValueForReference = importedValue(
      node,
      modulePattern,
      parents,
    );
    if (
      importedValueForReference?.type === "member" &&
      importedValueForReference.name === exportName &&
      !canBeDirectCallOrConstAlias(node)
    ) {
      panic(
        `${file} must use ${exportName} only as a direct call or const alias`,
      );
    }
    if (importedValueForReference?.type !== "namespace") {
      return;
    }
    const parent = parents.get(node);
    if (parent?.type === "MemberExpression" && parent.object === node) {
      const member = importedValue(parent, modulePattern, parents);
      if (member?.type === "member" && member.name === exportName) {
        return;
      }
    }
    panic(`${file} cannot use the ${exportName} namespace as a runtime value`);
  });
  return { imported, calls };
};
